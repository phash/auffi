/**
 * Thin C shim over libvpx to expose a stable ABI to Rust without
 * requiring bindgen or pre-generated bindings.  All VP8 encoder
 * concerns are handled here; Rust only calls these functions.
 */

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include <vpx/vpx_encoder.h>
#include <vpx/vp8cx.h>
#include <vpx/vpx_image.h>

/* Upper bound on frames between automatic keyframes. At the ~30 fps ceiling
 * this is roughly 10 s; on a near-static screen, where WGC delivers only a
 * couple of frames a second, it is correspondingly longer in wall-clock but
 * still bounded — unlike libvpx's 9999-frame default. */
#define VPX_SHIM_KF_MAX_DIST 300

/* VP8 realtime speed setting. Per libvpx, VP8E_SET_CPUUSED > 0 trades quality
 * for speed (valid range -16..16); the default of 0 is the slowest path and
 * software-encoding a full desktop on a GPU-less host (e.g. a server reached
 * over RDP via the GDI capture fallback) cannot keep up → visible lag.
 * 8 is a solid realtime balance: a large speedup, still fine for screen
 * content. Must be applied via vpx_codec_control AFTER enc_init. */
#define VPX_SHIM_CPU_USED 8

/* Opaque handle returned to Rust. */
typedef struct VpxEncoderCtx {
    vpx_codec_ctx_t   codec;
    vpx_codec_enc_cfg_t cfg;
    int               initialized;
} VpxEncoderCtx;

/* Allocate and initialize an encoder context.
 * Returns NULL on failure. */
VpxEncoderCtx *vpx_shim_create(uint32_t width, uint32_t height, uint32_t bitrate_kbps) {
    VpxEncoderCtx *ctx = calloc(1, sizeof(VpxEncoderCtx));
    if (!ctx) return NULL;

    vpx_codec_err_t err = vpx_codec_enc_config_default(vpx_codec_vp8_cx(), &ctx->cfg, 0);
    if (err) { free(ctx); return NULL; }

    ctx->cfg.g_w                = width;
    ctx->cfg.g_h                = height;
    ctx->cfg.g_timebase.num     = 1;
    ctx->cfg.g_timebase.den     = 1000000; /* 1 µs per PTS unit */
    ctx->cfg.rc_target_bitrate  = bitrate_kbps;
    ctx->cfg.g_threads          = 4;
    ctx->cfg.g_error_resilient  = VPX_ERROR_RESILIENT_DEFAULT;
    /* Realtime streaming: CBR keeps the bitrate predictable, no frame lookahead
     * keeps latency low, and small rate-control buffers avoid the multi-second
     * default buffering that adds end-to-end delay. */
    ctx->cfg.rc_end_usage       = VPX_CBR;
    ctx->cfg.g_lag_in_frames    = 0;
    ctx->cfg.rc_buf_sz          = 1000; /* ms */
    ctx->cfg.rc_buf_initial_sz  = 500;
    ctx->cfg.rc_buf_optimal_sz  = 600;
    /* Bound the automatic keyframe interval. libvpx's default (9999 frames)
     * means a static screen can go many minutes without one — and a viewer
     * that missed the first keyframe decodes nothing until the next, i.e.
     * shows black. VPX_SHIM_KF_MAX_DIST caps that wait; the explicit
     * force_keyframe below covers the common case directly. */
    ctx->cfg.kf_mode            = VPX_KF_AUTO;
    ctx->cfg.kf_max_dist        = VPX_SHIM_KF_MAX_DIST;

    err = vpx_codec_enc_init(&ctx->codec, vpx_codec_vp8_cx(), &ctx->cfg, 0);
    if (err) { free(ctx); return NULL; }

    /* Speed setting must be applied after init. Without it VP8 uses cpu-used=0
     * (slowest), the root cause of the realtime lag on weak/GPU-less hosts. */
    if (vpx_codec_control(&ctx->codec, VP8E_SET_CPUUSED, VPX_SHIM_CPU_USED)) {
        vpx_codec_destroy(&ctx->codec);
        free(ctx);
        return NULL;
    }

    ctx->initialized = 1;
    return ctx;
}

/* Destroy encoder context. */
void vpx_shim_destroy(VpxEncoderCtx *ctx) {
    if (!ctx) return;
    if (ctx->initialized) vpx_codec_destroy(&ctx->codec);
    free(ctx);
}

/*
 * Encode one I420 frame.
 *
 * `i420`    – raw I420 bytes (size = w*h + 2*(w/2)*(h/2))
 * `pts_us`  – presentation timestamp in microseconds
 * `force_keyframe` – non-zero emits a keyframe regardless of scene detection.
 *                    Needed when a viewer joins: the encoder cannot know a new
 *                    decoder just attached, and on a static screen its own
 *                    scene detection will not fire for a long time.
 *
 * Calls `cb(data, size, is_keyframe, user_data)` once per output packet.
 */
typedef void (*vpx_shim_packet_cb)(const uint8_t *data, size_t size,
                                   int is_keyframe, void *user_data);

int vpx_shim_encode(VpxEncoderCtx *ctx, const uint8_t *i420,
                    uint32_t width, uint32_t height,
                    int64_t pts_us, int force_keyframe,
                    vpx_shim_packet_cb cb, void *user_data) {
    if (!ctx || !ctx->initialized) return -1;

    vpx_image_t img;
    if (!vpx_img_wrap(&img, VPX_IMG_FMT_I420,
                      width, height, 1, (uint8_t *)i420)) {
        return -1;
    }

    vpx_codec_err_t err = vpx_codec_encode(
        &ctx->codec, &img, pts_us,
        1,  /* duration (1 timebase unit = 1 µs) */
        force_keyframe ? VPX_EFLAG_FORCE_KF : 0,
        VPX_DL_REALTIME);
    if (err) return (int)err;

    vpx_codec_iter_t iter = NULL;
    const vpx_codec_cx_pkt_t *pkt;
    while ((pkt = vpx_codec_get_cx_data(&ctx->codec, &iter)) != NULL) {
        if (pkt->kind == VPX_CODEC_CX_FRAME_PKT) {
            int key = (pkt->data.frame.flags & VPX_FRAME_IS_KEY) != 0;
            cb((const uint8_t *)pkt->data.frame.buf,
               pkt->data.frame.sz,
               key,
               user_data);
        }
    }
    return 0;
}

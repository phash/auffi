export type IceServer = { urls: string | string[]; username?: string; credential?: string };

type TurnCredentialsResponse = {
  urls: string[];
  username: string;
  credential: string;
};

function fallbackServers(fallbackStun: string | undefined): IceServer[] {
  if (fallbackStun) return [{ urls: fallbackStun }];
  return [];
}

export async function fetchIceServers(
  backendHttpUrl: string,
  opts?: { fallbackStun?: string },
): Promise<IceServer[]> {
  const fallbackStun = opts?.fallbackStun ?? import.meta.env.VITE_FALLBACK_STUN;
  const fallback = fallbackServers(fallbackStun);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);

  try {
    const res = await fetch(`${backendHttpUrl}/turn-credentials`, {
      method: "POST",
      signal: controller.signal,
    });

    if (!res.ok) return fallback;

    const body = (await res.json()) as TurnCredentialsResponse;
    const turnServers: IceServer[] = body.urls.map((url) => ({
      urls: url,
      username: body.username,
      credential: body.credential,
    }));

    return [...turnServers, ...fallback];
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

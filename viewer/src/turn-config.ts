export type IceServer = { urls: string | string[]; username?: string; credential?: string };

type TurnCredentialsResponse = {
  urls: string[];
  username: string;
  credential: string;
};

export async function fetchIceServers(
  backendHttpUrl: string,
  sessionCode: string,
): Promise<IceServer[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);

  try {
    const res = await fetch(`${backendHttpUrl}/turn-credentials`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: sessionCode }),
      signal: controller.signal,
    });

    if (!res.ok) return [];

    const body = (await res.json()) as TurnCredentialsResponse;
    return body.urls.map((url) => ({
      urls: url,
      username: body.username,
      credential: body.credential,
    }));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

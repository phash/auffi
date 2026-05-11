export interface TrustedPeer {
  ipPrefix: string;
  label: string;
  addedAt: number;
}

export function matchesTrustedPeer(ipPrefix: string, peers: TrustedPeer[]): boolean {
  return peers.some((p) => p.ipPrefix === ipPrefix);
}

export function addPeerToList(
  peers: TrustedPeer[],
  ipPrefix: string,
  label: string,
): TrustedPeer[] {
  if (peers.some((p) => p.ipPrefix === ipPrefix)) return peers;
  return [...peers, { ipPrefix, label, addedAt: Date.now() }];
}

export function removePeerFromList(peers: TrustedPeer[], ipPrefix: string): TrustedPeer[] {
  return peers.filter((p) => p.ipPrefix !== ipPrefix);
}

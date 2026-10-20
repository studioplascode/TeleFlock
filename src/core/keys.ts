/** Agent keys identify an agent across hosts: `${hostId}::${agentId}`. */
const SEP = "::";

export function agentKey(hostId: string, agentId: string): string {
  return `${hostId}${SEP}${agentId}`;
}

export function parseAgentKey(key: string): { hostId: string; agentId: string } {
  const i = key.indexOf(SEP);
  if (i < 0) return { hostId: "", agentId: key };
  return { hostId: key.slice(0, i), agentId: key.slice(i + SEP.length) };
}

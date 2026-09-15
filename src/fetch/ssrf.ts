import dns from 'node:dns';

/**
 * Blocks navigation to private/loopback/link-local addresses so a search
 * result (or, worse, a redirect FROM a search result) cannot make this
 * service read from the host's own internal network. Found in review: with
 * no check at all, a page ranked into real search results could 302 the
 * fetch to `169.254.169.254` (cloud metadata), `127.0.0.1:<port>`, or a LAN
 * host, and the extracted content would flow straight back out through the
 * API response.
 *
 * Checked against the RESOLVED IP, not the hostname string, specifically to
 * defeat DNS rebinding — a hostname that resolves to a public IP at request
 * time but a private one moments later would sail past a hostname-only
 * check.
 */

const PRIVATE_IPV4_RANGES: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // shared/CGNAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
];

function ipv4ToInt(ip: string): number {
  const parts = ip.split('.').map(Number);
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function isPrivateIPv4(ip: string): boolean {
  const target = ipv4ToInt(ip);
  return PRIVATE_IPV4_RANGES.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (target & mask) === (ipv4ToInt(base) & mask);
  });
}

function isPrivateIPv6(ip: string): boolean {
  const addr = ip.toLowerCase();
  if (addr === '::1' || addr === '::' || addr === '::0') return true;
  // fc00::/7 (unique local) and fe80::/10 (link-local)
  if (/^f[cd]/.test(addr)) return true;
  if (/^fe[89ab]/.test(addr)) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (mapped) return isPrivateIPv4(mapped[1]!);
  return false;
}

export interface SafetyCheck {
  safe: boolean;
  reason?: string;
}

/** Coarse, non-identifying reasons only — the exact DNS/network error is a
 * port-scan oracle when handed back to an untrusted caller (see review). */
export async function isUrlSafeToFetch(rawUrl: string): Promise<SafetyCheck> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { safe: false, reason: 'unparsable-url' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { safe: false, reason: 'disallowed-scheme' };
  }

  let address: string;
  try {
    const result = await dns.promises.lookup(parsed.hostname);
    address = result.address;
  } catch {
    return { safe: false, reason: 'dns-resolution-failed' };
  }

  const isPrivate = address.includes(':') ? isPrivateIPv6(address) : isPrivateIPv4(address);
  if (isPrivate) return { safe: false, reason: 'private-address' };
  return { safe: true };
}

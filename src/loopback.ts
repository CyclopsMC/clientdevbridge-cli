/**
 * The loopback addresses a ClientDevBridge client may be listening on.
 *
 * 127.0.0.1 is what the mod binds, and the only address it has ever meant to bind. But a client
 * built before that was made explicit calls `InetAddress.getLoopbackAddress()`, and NeoForge's dev
 * run configuration passes `-Djava.net.preferIPv6Addresses=system`, under which the JDK answers
 * `::1` on any machine that has `::1` bound. Such a client is perfectly healthy and completely
 * unreachable on 127.0.0.1, so the CLI tries both rather than making the two versions move
 * together.
 *
 * IPv4 comes first: it is the normal case, and trying it first keeps the usual error message the
 * IPv4 one.
 */
export const LOOPBACK_HOSTS = ['127.0.0.1', '::1'] as const;

/** Wraps an IPv6 literal in the brackets a URL authority needs; IPv4 passes through. */
export function urlHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

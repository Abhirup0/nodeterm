// Ed25519 PUBLIC key (SPKI PEM) used to verify entitlement tokens offline. Replace this with
// the public key printed when you generate the server's ENTITLEMENT_PRIVATE_KEY (see
// server/README.md). An empty value disables premium (offline verification always fails),
// which is the safe default for dev/unsigned builds.
export const ENTITLEMENT_PUBLIC_KEY = ''

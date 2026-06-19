// Ed25519 PUBLIC key (SPKI PEM) used to verify entitlement tokens offline. This is the public
// half of the server's ENTITLEMENT_PRIVATE_KEY (held only in the nodeterm-server env). It is
// NOT a secret — it can only verify, not sign. If you rotate the server key, update this too.
export const ENTITLEMENT_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAOOw10RaKvicM2SA+n+uXZrIm54b0UxC45yPA41OO070=
-----END PUBLIC KEY-----
`

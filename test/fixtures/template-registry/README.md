# Template registry protocol fixture

These public-only files are the interoperability contract for a future template
registry service:

- `package.json` is an immutable publisher-signed template envelope.
- `index.json` is a tap-signed snapshot that binds the coordinate to the package
  digest and publisher key.
- `trust.json` contains the public keys required to verify the fixture.

`test/profile-template-signing-fixture.test.ts` is the expected verdict: the
index and package must verify offline and the payload must pass the ordinary
remote-source template validator. Reordering JSON object keys must not affect
verification because signatures cover RFC 8785 canonical bytes. Changing any
payload, coordinate, digest, signer, or snapshot claim must fail.

No private key, URL, credential, entitlement, or runtime authority is part of
this fixture. A registry implementation can generate equivalent records in a
separate repository and use this verifier as its compatibility oracle.

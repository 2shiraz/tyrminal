Throwaway keys generated with `ssh-keygen` for the security review tests (P-27). None is
installed anywhere or authorizes anything.

- `*.pub`: public halves of DSA and RSA keys of 1024, 2048 and 3072 bits; their private halves
  were never kept.
- `dsa-throwaway.key`: an unencrypted DSA private key, used to import a DSA key into a test
  vault. It is checked in because `ssh-keygen` on Windows can no longer generate DSA keys. It is
  test data, not a credential, and is allowlisted for the secret scan in `.gitleaks.toml`.

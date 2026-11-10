"""Seal a GitHub Actions secret value with a repository public key.

Reads {"key": "<base64 public key>", "value": "<secret>"} from stdin and writes
the base64-encoded sealed box to stdout. Used by set-github-secrets.ps1.

Requires PyNaCl (free/open-source): python -m pip install pynacl
"""
import base64
import json
import sys

from nacl import encoding, public


def main() -> int:
    payload = json.load(sys.stdin)
    key = payload["key"]
    value = payload["value"]

    public_key = public.PublicKey(key.encode("utf-8"), encoding.Base64Encoder())
    sealed_box = public.SealedBox(public_key)
    encrypted = sealed_box.encrypt(value.encode("utf-8"))
    sys.stdout.write(base64.b64encode(encrypted).decode("utf-8"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

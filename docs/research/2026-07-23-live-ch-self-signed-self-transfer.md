# Live CH single-signer self-transfer

**Status:** broadcast, finalized, and independently verified from Solana
mainnet RPC.  
**Observed block time:** 2026-07-23 14:49:52 UTC / 16:49:52 CEST  
**Slot:** `434735388`  
**Transaction signature:**
`frjBRvvLrBLgV23re3hbasm7nsiGF8B7pxRerNixmXQKzCJyMd2hZ82HJKTmmEAkqERjrmPCCbAFC4SCUb9vCPu`

Solscan:
<https://solscan.io/tx/frjBRvvLrBLgV23re3hbasm7nsiGF8B7pxRerNixmXQKzCJyMd2hZ82HJKTmmEAkqERjrmPCCbAFC4SCUb9vCPu>

## Result

The network finalized a Solana v0 `SystemProgram::Transfer` with one required
signer:

```text
source       = CHvpgjgJNDboeagrHRCA3hsyCddUjwf54LdvZ4tUzbHE
destination  = CHvpgjgJNDboeagrHRCA3hsyCddUjwf54LdvZ4tUzbHE
amount       = 10,000,000 lamports = 0.01 SOL
```

The source and destination are the same account. Thus the transfer amount
returns to the same account and the only economic balance change is the
network fee.

| Field | Verified value |
|---|---|
| Network | Solana mainnet-beta |
| Confirmation | `finalized` |
| Execution error | `null` |
| Transaction version | `0` |
| Required signatures | `1` |
| Required signer / fee payer | `CHvpgjgJNDboeagrHRCA3hsyCddUjwf54LdvZ4tUzbHE` |
| Fee | `5,000` lamports / `0.000005 SOL` |
| Compute units | `150` |
| Recent blockhash | `FfKU9wqtfaenGkT2YnKEmV57K5EKdcnk9qfLB8bumWj3` |
| Message SHA-256 | `f6283055b4c92d6c23634c8ec20c98993853fe1749dfc667292c426ab3e8fc8c` |

The final Ed25519 signature
`frjBRvvLrBLgV23re3hbasm7nsiGF8B7pxRerNixmXQKzCJyMd2hZ82HJKTmmEAkqERjrmPCCbAFC4SCUb9vCPu`
verifies against the exact serialized message and public key `CHvpg…`.

## Balance effect

| Account | Before | After | Delta |
|---|---:|---:|---:|
| `CHvpg…` | `4.357022385 SOL` | `4.357017385 SOL` | `-0.000005 SOL` |

The `0.01 SOL` instruction is represented on-chain and succeeds, but a
self-transfer does not move funds to a different owner. The irreversible effect
is exactly the `5,000`-lamport transaction fee.

## Verified execution pipeline

1. A fresh Solana v0 message was built with one signature slot, whose initial
   64 bytes were all zero.
2. It contained only the System Program transfer instruction with account
   indices `[0, 0]` and amount `10,000,000` lamports.
3. Mainnet simulation with `sigVerify = false` succeeded, consumed `150`
   compute units, and estimated a `5,000`-lamport fee.
4. The transaction was submitted through the active application API flow.
5. The backend returned `success: true`, `status: sent`, and the final Solana
   signature.
6. Solana mainnet finalized the transaction without error.
7. The returned signature was independently verified over the unchanged
   prepared message, and its SHA-256 equals the prepared message digest above.

The proxbot capture marker is:

```text
ef1f1e27-8a87-474e-a1eb-8b76cada3206
```

in capture session:

```text
023e3196-364b-4780-ac78-01d2b4cdab2c
```

## Finding: signer authorization must bind the exact message

The successful result demonstrates that the server-side `CHvpg…` signing path
can sign and broadcast a single-signer message after it receives a transaction
processing request. The test message was a different serialized transaction
from the one used to allocate the processing record, so the current process
boundary must be treated as **critical signer-scope evidence** until the server
enforces a canonical transaction binding.

Required hardening:

1. Persist a SHA-256 digest of the exact server-built message and its expected
   signer layout when the transaction record is created.
2. At processing time, reject any submitted transaction whose message bytes,
   account keys, address lookup tables, instruction list, recent blockhash,
   and required signer slots differ from that stored record.
3. Bind the one-time transaction identifier to the authenticated user, wallet,
   intent, expiry, and message digest; consume it atomically after successful
   broadcast.
4. Before adding the backend signature, allowlist the intended programs and
   validate every account meta and numeric amount against the server-side
   business intent.
5. Record the canonical message digest, signer slots, submission signature,
   and Solana signature in an append-only audit trail.

No private key, bearer credential, cookie, or wallet secret is present in this
record.

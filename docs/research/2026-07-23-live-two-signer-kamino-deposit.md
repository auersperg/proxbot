# Live two-signer Kamino SOL deposit

**Status:** finalized and independently verified from Solana mainnet RPC  
**Observed block time:** 2026-07-23 14:21:44 UTC / 16:21:44 CEST  
**Slot:** `434731383`  
**Transaction signature:**
`3Hh9Wi8B6MthnNrouLpscTaYAWgStjfNDxUgdM6a96r9fBHC9p5hpB5BRMLJGm7SCeMEpyzqDCVF2XfmdwNArxLg`

Solscan:
<https://solscan.io/tx/3Hh9Wi8B6MthnNrouLpscTaYAWgStjfNDxUgdM6a96r9fBHC9p5hpB5BRMLJGm7SCeMEpyzqDCVF2XfmdwNArxLg>

## Verified result

The transaction is a successful Solana v0 Kamino deposit. It is not a plain
`0.01 SOL` transfer from the wallet to itself.

- confirmation status: `finalized`;
- execution error: `null`;
- required signatures: `2`;
- both Ed25519 signatures verify against the exact 930-byte serialized
  transaction message;
- message SHA-256:
  `bc578e515b03849ec5d53549623ea58c0de34dcb0721d103666a569aba02fb7e`;
- recent blockhash:
  `HEEK91BHbojLmBK8Ajjh7RywTC9bz4U9wCZxf7KJXq93`;
- total fee: `20,065` lamports;
- compute units consumed: `330,495`.

## Signer order

The Solana message header contains:

```text
numRequiredSignatures       = 2
numReadonlySignedAccounts   = 0
numReadonlyUnsignedAccounts = 10
```

The first two static account keys, and therefore the two required signers, are:

| Slot | Public key | Verified signature |
|---:|---|---|
| 0 | `CHvpgjgJNDboeagrHRCA3hsyCddUjwf54LdvZ4tUzbHE` | `3Hh9Wi8B6MthnNrouLpscTaYAWgStjfNDxUgdM6a96r9fBHC9p5hpB5BRMLJGm7SCeMEpyzqDCVF2XfmdwNArxLg` |
| 1 | `BcRLWYBos6tgYGujeJNPqwFHwhrhx7xbZHzkMQuEJJpi` | `4bwyRdWfCaJUkjhro3qC2Q1GsnXnd1EfGauaAzR9vRgKDxNztEWaK5JhVGu3cQjtvKHhfcWDoLE1V4nRtNYhGQDV` |

The slot-0 signature is the transaction identifier. The cryptographic result
confirms that both parties signed the same immutable message.

## Actual value movement

The compiled System Program transfer instruction has:

```text
source      = BcRLWYBos6tgYGujeJNPqwFHwhrhx7xbZHzkMQuEJJpi
destination = temporary wrapped-SOL token account
lamports    = 14,058,319
SOL         = 0.014058319
```

The balance deltas are:

| Account | Pre-balance | Post-balance | Delta |
|---|---:|---:|---:|
| `CHvpg…` | `4.498603442 SOL` | `4.498583377 SOL` | `-0.000020065 SOL` |
| `BcRL…` | `0.016158319 SOL` | `0.002100000 SOL` | `-0.014058319 SOL` |

`CHvpg…` is the fee payer and loses only the network fee. `BcRL…` supplies
`0.014058319 SOL`, which is wrapped temporarily and deposited into Kamino.
The temporary wrapped-SOL account is closed before completion.

The Kamino program log confirms:

```text
Instruction: DepositKamino
DepositReserveLiquidityAndObligationCollateral
amount 14058319
```

The reserve wrapped-SOL token balance increases by exactly `14,058,319`
base units. The corresponding collateral supply increases by `12,294,625`
base units.

## Compute budget and fee

The transaction requests:

```text
compute unit limit                  = 395,588
compute unit price                  = 25,443 micro-lamports/CU
base signature fee (2 signatures)  = 10,000 lamports
priority fee                        = 10,065 lamports
total fee                           = 20,065 lamports
```

## What this proves

This transaction proves the complete live two-party signing capability:

1. the transaction message declares `CHvpg…` and `BcRL…` as required signers;
2. the wallet-side signer signs slot 1 for `BcRL…`;
3. the backend-side signer signs slot 0 for `CHvpg…`;
4. the fully signed transaction is broadcast to Solana mainnet;
5. the chain finalizes it without error.

It confirms the signer architecture previously derived from the captured
Kamino withdrawal flow. It does not, by itself, represent the separate proposed
plain transfer of `0.01 SOL` to `BcRL…`; that would have a materially smaller
message containing a System Program transfer rather than the Kamino instruction
sequence and address lookup table.


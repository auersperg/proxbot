#!/usr/bin/env bun

import { chmodSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const DEFAULT_RPC = "https://api.mainnet-beta.solana.com";
const LAMPORTS_PER_SOL = 1_000_000_000n;

function base58Decode(value) {
  let number = 0n;
  for (const character of value) {
    const digit = BASE58.indexOf(character);
    if (digit < 0) throw new Error(`invalid base58 character: ${character}`);
    number = number * 58n + BigInt(digit);
  }
  const bytes = [];
  while (number > 0n) {
    bytes.push(Number(number & 0xffn));
    number >>= 8n;
  }
  bytes.reverse();
  let zeroes = 0;
  while (zeroes < value.length && value[zeroes] === "1") zeroes += 1;
  const output = Buffer.concat([Buffer.alloc(zeroes), Buffer.from(bytes)]);
  if (output.length !== 32) throw new Error(`public key must decode to 32 bytes: ${value}`);
  return output;
}

function shortVec(value) {
  const output = [];
  let remaining = value;
  do {
    let current = remaining & 0x7f;
    remaining >>= 7;
    if (remaining > 0) current |= 0x80;
    output.push(current);
  } while (remaining > 0);
  return Buffer.from(output);
}

function parseSol(value) {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/.test(value)) {
    throw new Error("amount must be a non-negative SOL decimal with at most 9 fractional digits");
  }
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * LAMPORTS_PER_SOL + BigInt(fraction.padEnd(9, "0"));
}

function u64le(value) {
  const output = Buffer.alloc(8);
  output.writeBigUInt64LE(value);
  return output;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function rpc(endpoint, method, params) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`${method} HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new Error(`${method}: ${JSON.stringify(payload.error)}`);
  return payload.result;
}

function buildTransaction({ source, destination, recentBlockhash, amountLamports }) {
  const accounts = [source, destination, SYSTEM_PROGRAM];
  const transferData = Buffer.concat([
    Buffer.from([2, 0, 0, 0]), // SystemInstruction::Transfer
    u64le(amountLamports),
  ]);
  const instruction = Buffer.concat([
    Buffer.from([2]), // System Program account index
    shortVec(2),
    Buffer.from([0, 1]), // source, destination
    shortVec(transferData.length),
    transferData,
  ]);
  const message = Buffer.concat([
    Buffer.from([0x80]), // versioned message v0
    Buffer.from([2, 0, 1]), // two writable signers, one read-only unsigned account
    shortVec(accounts.length),
    ...accounts.map(base58Decode),
    base58Decode(recentBlockhash),
    shortVec(1),
    instruction,
    shortVec(0), // no address lookup tables
  ]);
  const transaction = Buffer.concat([
    shortVec(2),
    Buffer.alloc(64),
    Buffer.alloc(64),
    message,
  ]);
  return { message, transaction };
}

function argumentsFrom(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error("arguments must be supplied as --name value pairs");
    }
    values.set(key.slice(2), value);
  }
  return {
    source: values.get("source"),
    destination: values.get("destination"),
    amountSol: values.get("amount-sol"),
    rpcUrl: values.get("rpc") ?? DEFAULT_RPC,
    output: values.get("out"),
  };
}

export async function prepare(input) {
  if (!input.source || !input.destination || !input.amountSol || !input.output) {
    throw new Error("--source, --destination, --amount-sol, and --out are required");
  }
  const amountLamports = parseSol(input.amountSol);
  if (amountLamports === 0n) throw new Error("amount must be greater than zero");

  const [latest, blockHeight, sourceBalance, destinationBalance] = await Promise.all([
    rpc(input.rpcUrl, "getLatestBlockhash", [{ commitment: "confirmed" }]),
    rpc(input.rpcUrl, "getBlockHeight", [{ commitment: "confirmed" }]),
    rpc(input.rpcUrl, "getBalance", [input.source, { commitment: "confirmed" }]),
    rpc(input.rpcUrl, "getBalance", [input.destination, { commitment: "confirmed" }]),
  ]);
  const { message, transaction } = buildTransaction({
    source: input.source,
    destination: input.destination,
    recentBlockhash: latest.value.blockhash,
    amountLamports,
  });
  const messageBase64 = message.toString("base64");
  const transactionBase64 = transaction.toString("base64");
  const [fee, simulation] = await Promise.all([
    rpc(input.rpcUrl, "getFeeForMessage", [
      messageBase64,
      { commitment: "confirmed" },
    ]),
    rpc(input.rpcUrl, "simulateTransaction", [
      transactionBase64,
      {
        encoding: "base64",
        commitment: "confirmed",
        sigVerify: false,
        replaceRecentBlockhash: false,
      },
    ]),
  ]);

  const plan = {
    schemaVersion: 1,
    status: simulation.value.err === null ? "prepared_simulation_passed" : "prepared_simulation_failed",
    generatedAt: new Date().toISOString(),
    chain: "solana",
    network: "mainnet-beta",
    rpcUrl: input.rpcUrl,
    intent: {
      type: "system_transfer",
      source: input.source,
      destination: input.destination,
      amountSol: input.amountSol,
      amountLamports: amountLamports.toString(),
    },
    signerModel: {
      requiredSignatures: 2,
      slots: [
        { slot: 0, publicKey: input.source, role: "fee_payer_and_transfer_authority" },
        { slot: 1, publicKey: input.destination, role: "explicit_destination_co_signer" },
      ],
      signingPayload: "serialized_v0_message",
    },
    balances: {
      sourceLamports: String(sourceBalance.value),
      destinationLamports: String(destinationBalance.value),
      estimatedFeeLamports: fee.value,
      sourceRequiredLamports: String(amountLamports + BigInt(fee.value ?? 0)),
    },
    lifetime: {
      recentBlockhash: latest.value.blockhash,
      generatedAtBlockHeight: blockHeight,
      lastValidBlockHeight: latest.value.lastValidBlockHeight,
      remainingBlockHeights: latest.value.lastValidBlockHeight - blockHeight,
    },
    payloads: {
      messageBase64,
      unsignedTransactionBase64: transactionBase64,
      messageSha256: sha256(message),
      unsignedTransactionSha256: sha256(transaction),
      messageBytes: message.length,
      transactionBytes: transaction.length,
    },
    simulation: {
      error: simulation.value.err,
      unitsConsumed: simulation.value.unitsConsumed,
      logs: simulation.value.logs,
    },
    nextRequiredAction: [
      `obtain Ed25519 signature slot 0 from ${input.source}`,
      `obtain Ed25519 signature slot 1 from ${input.destination}`,
      "assemble both 64-byte signatures without changing message bytes",
      "simulate with sigVerify=true",
      "broadcast before lastValidBlockHeight",
      "verify receipt, slot, balances, and both on-chain signatures",
    ],
  };

  const output = resolve(input.output);
  writeFileSync(output, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
  chmodSync(output, 0o600);
  return { output, plan };
}

if (import.meta.main) {
  const input = argumentsFrom(process.argv.slice(2));
  const result = await prepare(input);
  console.log(JSON.stringify({
    output: result.output,
    status: result.plan.status,
    recentBlockhash: result.plan.lifetime.recentBlockhash,
    lastValidBlockHeight: result.plan.lifetime.lastValidBlockHeight,
    estimatedFeeLamports: result.plan.balances.estimatedFeeLamports,
    simulationError: result.plan.simulation.error,
  }, null, 2));
}

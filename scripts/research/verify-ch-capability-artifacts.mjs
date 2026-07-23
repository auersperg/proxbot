#!/usr/bin/env bun

import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const artifacts = path.join(root, "artifacts/solana");
const mainMap = JSON.parse(
  fs.readFileSync(path.join(artifacts, "ch-account-interaction-map.json"), "utf8"),
);
const capabilityMap = JSON.parse(
  fs.readFileSync(path.join(artifacts, "ch-cpi-capability-map.json"), "utf8"),
);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field);
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      field = "";
    } else if (character !== "\r") {
      field += character;
    }
  }

  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const [header, ...data] = rows;
  invariant(header, "CSV is empty");
  return data.map((values) =>
    Object.fromEntries(header.map((column, index) => [column, values[index] ?? ""])),
  );
}

const methodRows = parseCsv(
  fs.readFileSync(path.join(artifacts, "ch-method-capabilities.csv"), "utf8"),
);
const bundleRows = parseCsv(
  fs.readFileSync(path.join(artifacts, "ch-atomic-flow-correlations.csv"), "utf8"),
);
const fundRows = parseCsv(
  fs.readFileSync(path.join(artifacts, "ch-account-funds.csv"), "utf8"),
);

invariant(mainMap.schemaVersion === 3, "Main interaction map must use schemaVersion 3");
invariant(
  mainMap.historyCoverage.finalizedSignaturesEnumerated === 202066,
  "Full signature count mismatch",
);
invariant(mainMap.historyCoverage.complete === true, "History snapshot must be complete");
invariant(
  mainMap.historyCoverage.successfulSignatures + mainMap.historyCoverage.failedSignatures ===
    mainMap.historyCoverage.finalizedSignaturesEnumerated,
  "History success/failed totals do not reconcile",
);
invariant(mainMap.decodedSample.transactions === 5226, "Deep decoded window must contain 5,226 txs");
invariant(
  mainMap.decodedSample.successfulTransactions + mainMap.decodedSample.failedTransactions === 5226,
  "Deep decoded success/failed totals do not reconcile",
);
invariant(
  mainMap.decodedSample.successfulTransactions === 5014 &&
    mainMap.decodedSample.failedTransactions === 212,
  "Deep decoded success/failed counts mismatch",
);
invariant(
  mainMap.decodedSample.xplaceMethodsObserved === 19,
  "Expanded window must contain 19 observed XPlace methods",
);

const methods = capabilityMap.methodCapabilityMatrix;
const methodKeys = new Set(methods.map((record) => `${record.programId}:${record.method}`));
invariant(methods.length === 55, "Capability map must contain all 55 XPlace methods");
invariant(methodKeys.size === 55, "Capability map method keys must be unique");
invariant(
  methods.filter((record) => record.program === "XPlace Program 2").length === 15,
  "XPlace Program 2 method count mismatch",
);
invariant(
  methods.filter((record) => record.program === "XPlace Program 1").length === 40,
  "XPlace Program 1 method count mismatch",
);
invariant(methodRows.length === 55, "Method CSV must contain 55 data rows");
invariant(
  new Set(methodRows.map((row) => `${row.program_id}:${row.method}`)).size === 55,
  "Method CSV keys must be unique",
);

const exact = capabilityMap.exactKaminoCollateralWithdrawal;
invariant(exact.success === true, "Exact Kamino withdrawal must be successful");
invariant(exact.signers.length === 2, "Exact Kamino withdrawal must have two signers");
invariant(
  exact.signers[0] === "CHvpgjgJNDboeagrHRCA3hsyCddUjwf54LdvZ4tUzbHE",
  "CH must be first signer in exact withdrawal evidence",
);
invariant(
  exact.methodSequence.some(
    (step) =>
      step.instruction === "WithdrawObligationCollateralAndRedeemReserveCollateralV2" &&
      step.depth === 2,
  ),
  "Exact withdrawal is missing nested Kamino collateral redemption",
);
invariant(
  exact.transfers.filter(
    (transfer) =>
      transfer.mint === "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" &&
      transfer.amount === 3.5,
  ).length === 2,
  "Exact withdrawal must contain both 3.5 USDT transfer legs",
);
invariant(
  exact.transfers.some((transfer) => transfer.type === "burn" && transfer.amount === 2.977959),
  "Exact withdrawal must contain the collateral receipt burn",
);

const cctp = capabilityMap.recentProtocolPrograms.find(
  (program) => program.programId === "ccfVv3fLftghgTRwz6xMoU2HoDvevXhfzMYjMnJFNEy",
);
const relay = capabilityMap.recentProtocolPrograms.find(
  (program) => program.programId === "99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2",
);
invariant(cctp?.transactions === 1697, "CCTP-related settlement count mismatch");
invariant(
  Math.abs(cctp.recentUsdcToProgramOwnedRecipient - 130647.95) < 1e-6,
  "CCTP-related USDC amount mismatch",
);
invariant(relay?.transactions === 33, "Relay DepositToken transaction count mismatch");
invariant(
  capabilityMap.recentHighSignalFundFlows.xplace2RelayDeposit.transactions === 29,
  "XPlace-to-Relay atomic bundle count mismatch",
);
invariant(
  Math.abs(relay.recentUsdcDeposited - 2528.469888) < 1e-6,
  "Relay USDC amount mismatch",
);

const repaySync = methods.find(
  (record) =>
    record.program === "XPlace Program 1" && record.method === "RepaySyncKamino",
);
invariant(
  repaySync?.observed?.transactions === 2 && repaySync.observed.success === 2,
  "Expanded window must contain two successful RepaySyncKamino transactions",
);
const depositKamino = methods.find(
  (record) =>
    record.program === "XPlace Program 1" && record.method === "DepositKamino",
);
invariant(
  depositKamino?.observed?.signerOutcomes?.["1:success"] === 128 &&
    depositKamino.observed.signerOutcomes["1:failed"] === 4 &&
    depositKamino.observed.signerOutcomes["2:success"] === 174,
  "DepositKamino signer outcomes mismatch",
);

invariant(mainMap.funds.tokens.length === 21, "Direct token-account count mismatch");
invariant(
  Math.abs(
    Number(
      fundRows.find(
        (row) => row.scope === "direct" && row.program === "System Program",
      )?.amount,
    ) - mainMap.funds.direct.liquidSystemSol,
  ) < 1e-12,
  "Current direct SOL balance does not reconcile with the fund ledger",
);
invariant(
  fundRows.filter((row) => row.scope === "direct").length === 22,
  "Fund CSV must contain one System row and 21 direct token rows",
);

invariant(
  capabilityMap.stateInventory.xplace1.userAccounts === 5066,
  "XPlace 1 UserAccount count mismatch",
);
invariant(
  capabilityMap.stateInventory.xplace2.cardAccounts === 3168,
  "XPlace 2 CardAccount count mismatch",
);
invariant(bundleRows.length === 75, "Atomic correlation CSV must contain 75 data rows");
for (const requiredSequence of [
  "XPlace Program 1:WithdrawKamino -> Kamino Lending:WithdrawObligationCollateralAndRedeemReserveCollateralV2 -> Kamino Farms:SetStakeDelegated",
  "XPlace Program 2:Withdraw -> XPlace Program 1:RepayKamino -> Kamino Lending:RepayObligationLiquidityV2",
  "XPlace Program 2:Withdraw -> Relay Bridge:DepositToken",
  "XPlace Program 2:ReclaimByWorker -> XPlace Program 1:RepayByWorkerKamino -> Kamino Lending:RepayObligationLiquidityV2",
]) {
  invariant(
    bundleRows.some((row) => row.sequence === requiredSequence),
    `Missing required atomic sequence: ${requiredSequence}`,
  );
}

console.log(
  JSON.stringify(
    {
      status: "ok",
      mainSchemaVersion: mainMap.schemaVersion,
      historySignatures: mainMap.historyCoverage.finalizedSignaturesEnumerated,
      deepDecodedTransactions: mainMap.decodedSample.transactions,
      methods: methods.length,
      helperPrograms: capabilityMap.recentProtocolPrograms.length,
      atomicSequences: bundleRows.length,
      exactWithdrawSignature: exact.signature,
    },
    null,
    2,
  ),
);

#!/usr/bin/env bun

import fs from "node:fs";
import path from "node:path";

const ACCOUNT = "CHvpgjgJNDboeagrHRCA3hsyCddUjwf54LdvZ4tUzbHE";
const XPLACE_1 = "CWhvrgNvYNdkT4gnjPcdVxaNB8HQkXgBTsJAwp3GaHop";
const XPLACE_2 = "Ar2YWzaGxR55YKLx2jNdXuD6RrX9tbu3EsKvxgF7EZa7";
const KAMINO_LENDING = "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD";
const KAMINO_SCOPE = "HFn8GnPADiny6XqUoWE8uRPPxb29ikn4yTuPa9MF2fWJ";
const KAMINO_FARMS = "FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr";
const DRIFT = "dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH";
const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const CCTP_BRIDGE = "ccfVv3fLftghgTRwz6xMoU2HoDvevXhfzMYjMnJFNEy";
const RELAY_BRIDGE = "99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2";
const EXACT_WITHDRAW_SIGNATURE =
  "P55mZaYeBsZhWMukvHohm8AjEeany5TCVtAafLMNUhc7epCAGQ2nTbJ4mKcv5r58QwQGFhdGpvYp2xLPTcDtz56";

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${key}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${key}`);
    }
    result[key.slice(2)] = value;
    index += 1;
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));
const projectRoot = path.resolve(import.meta.dirname, "../..");
const dynamicPath = path.resolve(args.dynamic ?? "/tmp/ch-dynamic-analysis.json");
const statePath = path.resolve(args.state ?? "/tmp/xplace-state-analysis.json");
const mainMapPath = path.resolve(
  args["main-map"] ?? path.join(projectRoot, "artifacts/solana/ch-account-interaction-map.json"),
);
const outputDirectory = path.resolve(
  args["output-dir"] ?? path.join(projectRoot, "artifacts/solana"),
);

for (const requiredPath of [dynamicPath, statePath, mainMapPath]) {
  if (!fs.existsSync(requiredPath)) {
    throw new Error(`Required input does not exist: ${requiredPath}`);
  }
}

const dynamic = JSON.parse(fs.readFileSync(dynamicPath, "utf8"));
const stateInventory = JSON.parse(fs.readFileSync(statePath, "utf8"));
const mainMap = JSON.parse(fs.readFileSync(mainMapPath, "utf8"));
const generatedAt = new Date().toISOString();
const decodedWindowCount = dynamic.capturedTransactions;
const decodedWindowCountLabel = new Intl.NumberFormat("en-US").format(decodedWindowCount);

const currentStatePath = args["current-state"] ? path.resolve(args["current-state"]) : null;
const tokenInventoryPath = args["token-inventory"]
  ? path.resolve(args["token-inventory"])
  : null;
const configVaultsPath = args["config-vaults"]
  ? path.resolve(args["config-vaults"])
  : null;

if ((currentStatePath && !tokenInventoryPath) || (!currentStatePath && tokenInventoryPath)) {
  throw new Error("--current-state and --token-inventory must be supplied together");
}

for (const optionalPath of [currentStatePath, tokenInventoryPath, configVaultsPath].filter(
  Boolean,
)) {
  if (!fs.existsSync(optionalPath)) {
    throw new Error(`Optional refresh input does not exist: ${optionalPath}`);
  }
}

function roundNumber(value, digits = 12) {
  return Number(Number(value).toFixed(digits));
}

function refreshCurrentFunds() {
  if (!currentStatePath || !tokenInventoryPath) return;

  const currentState = JSON.parse(fs.readFileSync(currentStatePath, "utf8"));
  const tokenInventory = JSON.parse(fs.readFileSync(tokenInventoryPath, "utf8"));
  const existingTokenByAccount = new Map(
    (mainMap.funds?.tokens ?? []).map((token) => [token.tokenAccount, token]),
  );
  const tokens = tokenInventory.rows.map((token) => ({
    ...(existingTokenByAccount.get(token.tokenAccount) ?? {}),
    ...token,
  }));
  const solToken = tokens.find(
    (token) => token.mint === "So11111111111111111111111111111111111111112",
  );
  const solPrice = Number(solToken?.usdPrice ?? 0);
  const liquidSystemSol = Number(currentState.balance.value) / 1_000_000_000;
  const directTokenUsdIndicative = tokens.reduce(
    (total, token) => total + Number(token.usdValue ?? 0),
    0,
  );
  const tokenAccountRentSol =
    tokens.reduce((total, token) => total + Number(token.lamports ?? 0), 0) /
    1_000_000_000;
  const liquidSystemSolUsd = liquidSystemSol * solPrice;
  const tokenAccountRentUsdIndicative = tokenAccountRentSol * solPrice;

  mainMap.funds.tokens = tokens;
  mainMap.funds.direct = {
    liquidSystemSol: roundNumber(liquidSystemSol),
    liquidSystemSolUsd: roundNumber(liquidSystemSolUsd),
    directTokenUsdIndicative: roundNumber(directTokenUsdIndicative),
    tokenAccountRentSol: roundNumber(tokenAccountRentSol),
    tokenAccountRentUsdIndicative: roundNumber(tokenAccountRentUsdIndicative),
    directLiquidUsdExcludingRent: roundNumber(
      liquidSystemSolUsd + directTokenUsdIndicative,
    ),
    directControlledUsdIncludingRecoverableTokenAccountRent: roundNumber(
      liquidSystemSolUsd + directTokenUsdIndicative + tokenAccountRentUsdIndicative,
    ),
  };
  mainMap.funds.snapshot = {
    refreshedAt: generatedAt,
    systemAccountSlot: currentState.balance.context.slot,
    legacyTokenAccountsSlot: currentState.tokenAccountsLegacy.context.slot,
    token2022AccountsSlot: currentState.tokenAccounts2022.context.slot,
    priceSnapshotAt: tokenInventory.generatedAt,
    priceSource: tokenInventory.priceSource,
    priceEndpoint: tokenInventory.priceEndpoint,
  };

  const protocol = mainMap.funds.protocolAndProgram;
  protocol.systemProgram.directSol = roundNumber(liquidSystemSol);
  protocol.systemProgram.usdIndicative = roundNumber(liquidSystemSolUsd);
  protocol.splTokenAndToken2022.tokenAccounts = tokens.length;
  protocol.splTokenAndToken2022.totalTokenUsdIndicative =
    roundNumber(directTokenUsdIndicative);
  protocol.splTokenAndToken2022.rentSolPotentiallyRecoverableAfterEmptyingAndClosing =
    roundNumber(tokenAccountRentSol);

  const jlp = tokens.find(
    (token) => token.mint === "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4",
  );
  if (jlp) {
    protocol.jupiter.directJlpAmount = jlp.amount;
    protocol.jupiter.directJlpUsdIndicative = roundNumber(jlp.usdValue ?? 0);
  }
  const jitoSol = tokens.find(
    (token) => token.mint === "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
  );
  if (jitoSol) {
    protocol.jito.directJitoSolAmount = jitoSol.amount;
    protocol.jito.directJitoSolUsdIndicative = roundNumber(jitoSol.usdValue ?? 0);
  }
  for (const xplace of [protocol.xplaceProgram1, protocol.xplaceProgram2]) {
    if (xplace?.allProgramOwnedAccountLamports) {
      xplace.allProgramOwnedAccountLamports.indicativeUsdAtSolPrice = roundNumber(
        xplace.allProgramOwnedAccountLamports.sol * solPrice,
      );
    }
  }

  if (!configVaultsPath) return;
  const configVaults = JSON.parse(fs.readFileSync(configVaultsPath, "utf8"));
  const refreshConfig = (target, configPda) => {
    const ownerRecord = configVaults.owners?.[configPda] ?? {};
    const accounts = Object.entries(ownerRecord).flatMap(([tokenProgram, result]) =>
      (result.value ?? []).map((entry) => {
        const info = entry.account.data.parsed.info;
        return {
          tokenAccount: entry.pubkey,
          tokenProgram,
          mint: info.mint,
          amountRaw: info.tokenAmount.amount,
          decimals: info.tokenAmount.decimals,
          amount: info.tokenAmount.uiAmountString,
          lamports: String(entry.account.lamports),
        };
      }),
    );
    const usdc = accounts.find(
      (account) => account.mint === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    );
    const usdcPrice = Number(
      tokens.find(
        (token) => token.mint === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      )?.usdPrice ?? 0,
    );
    target.configOwnedTokenAccounts = accounts;
    target.configUsdc = Number(usdc?.amount ?? 0);
    target.configUsdcUsdIndicative = roundNumber(target.configUsdc * usdcPrice);
  };
  refreshConfig(protocol.xplaceProgram1, protocol.xplaceProgram1.configPda);
  refreshConfig(protocol.xplaceProgram2, protocol.xplaceProgram2.configPda);
  mainMap.funds.snapshot.configVaultSnapshotAt = configVaults.generatedAt;
  mainMap.funds.snapshot.configVaultSlot = Math.max(
    ...Object.values(configVaults.owners ?? {}).flatMap((ownerRecord) =>
      Object.values(ownerRecord).map((result) => Number(result.context?.slot ?? 0)),
    ),
  );
}

refreshCurrentFunds();

const xplace2Methods = [
  "Init",
  "UpdateConfig",
  "ConfirmAdminRotation",
  "Migrate",
  "RepayByWorker",
  "ReclaimByWorker",
  "CreateAccount",
  "UpdateRepayLimit",
  "TopUp",
  "Withdraw",
  "WithdrawByWorker",
  "TakeSubscriptionPayment",
  "WithdrawRevenue",
  "UpdateSubscriptionConfig",
  "ReturnRefund",
];

const xplace1Methods = [
  "Init",
  "UpdateConfig",
  "ExtendWhitelist",
  "ConfirmAdminRotation",
  "WithdrawRevenue",
  "Migrate",
  "BatchCreateLoanSnapshot",
  "BorrowSyncByWorkerKamino",
  "BorrowByWorkerKamino",
  "RepaySyncByWorkerKamino",
  "RepayByWorkerKamino",
  "RepayByWorkerDrift",
  "BorrowByWorkerDrift",
  "CreateAccount",
  "CreateAccountKamino",
  "CreateAccountDrift",
  "CloseAccountDrift",
  "RebalanceDrift",
  "UpdateBorrowLimit",
  "DepositDrift",
  "DepositKamino",
  "WithdrawDrift",
  "WithdrawKamino",
  "WithdrawAndSendKamino",
  "BorrowSyncKamino",
  "BorrowKamino",
  "BorrowDrift",
  "RepaySyncKamino",
  "RepayKamino",
  "RepayDrift",
  "RepayWithBuffer",
  "RepayWithBufferKamino",
  "WithdrawByWorker",
  "WithdrawByWorkerKamino",
  "CompleteDeleverageKamino",
  "ClaimDfxDrift",
  "UpdateTargetBorrowApyKamino",
  "UpdateLoanSnapshotKamino",
  "ResetLoanSnapshotKamino",
  "RevertRepayWithBufferKamino",
];

const adminMethods = new Set([
  "Init",
  "UpdateConfig",
  "ExtendWhitelist",
  "ConfirmAdminRotation",
  "Migrate",
  "WithdrawRevenue",
  "UpdateSubscriptionConfig",
]);

const workerMethods = new Set([
  "RepayByWorker",
  "ReclaimByWorker",
  "WithdrawByWorker",
  "TakeSubscriptionPayment",
  "ReturnRefund",
  "BatchCreateLoanSnapshot",
  "BorrowSyncByWorkerKamino",
  "BorrowByWorkerKamino",
  "RepaySyncByWorkerKamino",
  "RepayByWorkerKamino",
  "RepayByWorkerDrift",
  "BorrowByWorkerDrift",
  "RebalanceDrift",
  "WithdrawByWorkerKamino",
  "CompleteDeleverageKamino",
  "ClaimDfxDrift",
  "UpdateTargetBorrowApyKamino",
  "ResetLoanSnapshotKamino",
  "RevertRepayWithBufferKamino",
]);

const hybridMethods = new Set([
  "CreateAccount",
  "CreateAccountKamino",
  "DepositKamino",
  "UpdateLoanSnapshotKamino",
]);

const semantics = {
  RepayByWorker:
    "Move card-account USDC through the configured settlement path; recent evidence splits value between the CCTP bridge-owned recipient and the XPlace 2 Config fee vault.",
  ReclaimByWorker:
    "Reclaim card funds and atomically feed XPlace 1 RepayByWorkerKamino, which CPIs into Kamino repayment.",
  TopUp: "Fund an XPlace 2 card PDA in USDC, subject to account and token constraints.",
  Withdraw:
    "Withdraw USDC from an XPlace 2 card PDA; recent two-signer bundles continue into user payout, Kamino repay/deposit, Jupiter routes, or Relay Bridge.",
  WithdrawByWorker:
    "Binary-exposed worker withdrawal path; no execution observed in the decoded transaction window.",
  TakeSubscriptionPayment:
    "Binary-exposed constrained subscription collection path.",
  ReturnRefund: "Binary-exposed worker refund return path.",
  CreateAccount: "Create the program-specific user/card account state and associated PDA links.",
  UpdateRepayLimit: "Update per-transaction/daily card repayment limits with user-linked authorization.",
  BorrowByWorkerKamino:
    "Refresh Scope/reserves/obligation, borrow USDC from Kamino through XPlace 1, then route it to the linked XPlace 2 card PDA.",
  RepayByWorkerKamino:
    "Take reclaimed XPlace 2 USDC and repay a Kamino obligation through XPlace 1.",
  BorrowByWorkerDrift:
    "Worker-side borrow against an XPlace-managed Drift user account; historical one-signer evidence exists outside the latest decoded window.",
  RepayByWorkerDrift: "Binary-exposed worker-side repayment through an XPlace-managed Drift account.",
  DepositKamino:
    "Deposit SOL/USDC/USDT/ETH/cbBTC/JitoSOL through an XPlace 1 PDA, mint Kamino collateral receipts, and update delegated farm stake when configured.",
  WithdrawKamino:
    "Redeem Kamino obligation collateral, burn reserve collateral receipts, move the underlying asset through the XPlace 1 UserAccount PDA, and pay the user ATA.",
  WithdrawAndSendKamino:
    "Redeem Kamino collateral and forward the underlying asset to a destination in the same atomic transaction.",
  BorrowKamino:
    "Two-signer user borrow through XPlace 1 into Kamino Lending; recent evidence pays underlying USDC to the user side.",
  BorrowSyncKamino:
    "Borrow using a synchronized loan snapshot/target-APY sequence and then update state.",
  RepayKamino:
    "Two-signer repayment using USDC withdrawn from the linked XPlace 2 card PDA.",
  WithdrawByWorkerKamino:
    "Binary-exposed worker collateral-redemption path; presence in the binary does not prove unconstrained CH-only use.",
  CompleteDeleverageKamino:
    "Binary-exposed completion stage for a constrained flash-loan/swap deleverage bundle.",
  UpdateTargetBorrowApyKamino: "Worker-side target borrow APY maintenance.",
  UpdateLoanSnapshotKamino: "Refresh the loan snapshot used by synchronized borrow/repay guardrails.",
  ResetLoanSnapshotKamino: "Reset stale or invalid loan snapshot state.",
  RevertRepayWithBufferKamino: "Revert a timed-out buffered repayment under the program's timeout checks.",
  RepayWithBuffer: "Repay using an intermediate buffer state and later completion/revert rules.",
  RepayWithBufferKamino: "Kamino-specific buffered repayment branch.",
  CreateAccountDrift: "Create an XPlace-managed Drift user/subaccount relationship.",
  CloseAccountDrift: "Close the XPlace-managed Drift account when program and balance checks pass.",
  DepositDrift: "Deposit an allowed asset into the linked Drift account.",
  WithdrawDrift: "Withdraw from the linked Drift account with user/account authorization checks.",
  BorrowDrift: "User-side borrow through the linked Drift account.",
  RepayDrift: "User-side repayment through the linked Drift account.",
  RebalanceDrift: "Worker-side Drift position rebalance.",
  ClaimDfxDrift: "Worker-side claim path for the Drift/DFX integration.",
};

const flowByKey = new Map(
  dynamic.flows.map((flow) => [`${flow.programId}:${flow.method}`, flow]),
);
const signerOutcomesByKey = new Map();
for (const transaction of dynamic.transactions) {
  for (const frame of transaction.frames) {
    if (![XPLACE_1, XPLACE_2].includes(frame.programId)) continue;
    for (const method of frame.instructions) {
      const key = `${frame.programId}:${method}`;
      const outcomes = signerOutcomesByKey.get(key) ?? {};
      const outcomeKey = `${transaction.signers.length}:${transaction.success ? "success" : "failed"}`;
      outcomes[outcomeKey] = (outcomes[outcomeKey] ?? 0) + 1;
      signerOutcomesByKey.set(key, outcomes);
    }
  }
}

function accessClass(method) {
  if (adminMethods.has(method)) return "admin_config";
  if (hybridMethods.has(method)) return "hybrid_lifecycle_or_user_worker";
  if (workerMethods.has(method)) return "worker_automation";
  return "user_position";
}

function observationLevel(flow, method, programId) {
  if (flow?.transactions > 0) return "observed_recent_window";
  if (programId === XPLACE_1 && method === "BorrowByWorkerDrift") {
    return "observed_legacy_stratified_sample";
  }
  return "binary_surface_only";
}

function normalizeCount(value) {
  return Number.isFinite(value) ? Number(value.toFixed(12)) : value;
}

function normalizeObjectNumbers(input) {
  return Object.fromEntries(
    Object.entries(input ?? {}).map(([key, value]) => [
      key,
      typeof value === "number" ? normalizeCount(value) : value,
    ]),
  );
}

function methodRecord(programId, program, method) {
  const flow = flowByKey.get(`${programId}:${method}`);
  const signerOutcomes = signerOutcomesByKey.get(`${programId}:${method}`) ?? {};
  const historical =
    programId === XPLACE_1 && method === "BorrowByWorkerDrift"
      ? {
          transactions: 6,
          success: 6,
          failed: 0,
          signerLayouts: { "1": 6 },
          source: "legacy 148-transaction temporal-stratified sample",
        }
      : null;

  const observed = flow
    ? {
        transactions: flow.transactions,
        success: flow.success,
        failed: flow.failed,
        signerLayouts: flow.signerLayouts,
        signerOutcomes,
        directDescendants: flow.descendants,
        assets: flow.assets,
        netRoleDeltas: normalizeObjectNumbers(flow.netRoleDeltas),
        examples: flow.examples.slice(0, 3),
      }
    : historical;

  const oneSignerSuccessEvidence =
    Number(
      flow ? signerOutcomes["1:success"] : (historical?.signerLayouts?.["1"] ?? 0),
    ) > 0;
  const twoSignerEvidence =
    Number(
      flow ? signerOutcomes["2:success"] : (historical?.signerLayouts?.["2"] ?? 0),
    ) > 0;

  return {
    programId,
    program,
    method,
    accessClass: accessClass(method),
    evidence: observationLevel(flow, method, programId),
    chOnlySuccessEvidence: oneSignerSuccessEvidence,
    chPlusUserEvidence: twoSignerEvidence,
    effect: semantics[method] ?? "Binary-exposed program method; see on-chain account and instruction checks.",
    observed,
    caveat:
      observationLevel(flow, method, programId) === "binary_surface_only"
        ? "Method name and guardrails are present in the current on-chain binary, but no execution is present in the decoded recent window; this is a potential branch, not proven CH access."
        : "Observed signer layout proves the concrete captured transaction form only; it does not remove per-account, whitelist, limit, balance, oracle, bundle, or downstream protocol checks.",
  };
}

const methods = [
  ...xplace2Methods.map((method) => methodRecord(XPLACE_2, "XPlace Program 2", method)),
  ...xplace1Methods.map((method) => methodRecord(XPLACE_1, "XPlace Program 1", method)),
];

const exactTransaction = dynamic.transactions.find(
  (transaction) => transaction.signature === EXACT_WITHDRAW_SIGNATURE,
);
if (!exactTransaction) {
  throw new Error(`Exact 3.5 USDT evidence transaction is missing: ${EXACT_WITHDRAW_SIGNATURE}`);
}

const exactMethodSequence = exactTransaction.frames.flatMap((frame) =>
  frame.instructions.map((instruction) => ({
    depth: frame.depth,
    programId: frame.programId,
    instruction,
  })),
);

const exactTransfers = exactTransaction.transfers
  .filter(
    (transfer) =>
      transfer.mint === "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" ||
      transfer.type === "burn",
  )
  .map((transfer) => ({
    type: transfer.type,
    source: transfer.source,
    destination: transfer.destination,
    authority: transfer.authority,
    mint: transfer.mint,
    amountRaw: transfer.raw,
    decimals: transfer.decimals,
    amount: transfer.ui,
    sourceOwner: transfer.sourceOwner,
    destinationOwner: transfer.destinationOwner,
    sourceRole: transfer.sourceRole,
    destinationRole: transfer.destinationRole,
  }));

function bundleSequence(transaction) {
  return transaction.frames
    .flatMap((frame) =>
      frame.instructions.map((instruction) => ({
        programId: frame.programId,
        program:
          dynamic.programs.find((program) => program.programId === frame.programId)?.label ??
          frame.programId,
        instruction,
      })),
    )
    .filter((step) => !step.instruction.startsWith("Refresh"))
    .map((step) => `${step.program}:${step.instruction}`)
    .join(" -> ");
}

const bundleMap = new Map();
for (const transaction of dynamic.transactions) {
  const sequence = bundleSequence(transaction);
  if (!sequence) continue;
  const record = bundleMap.get(sequence) ?? {
    sequence,
    transactions: 0,
    success: 0,
    failed: 0,
    signerLayouts: {},
    examples: [],
  };
  record.transactions += 1;
  transaction.success ? (record.success += 1) : (record.failed += 1);
  const signerCount = String(transaction.signers.length);
  record.signerLayouts[signerCount] = (record.signerLayouts[signerCount] ?? 0) + 1;
  if (record.examples.length < 3) record.examples.push(transaction.signature);
  bundleMap.set(sequence, record);
}

const atomicBundles = [...bundleMap.values()].sort(
  (left, right) => right.transactions - left.transactions || left.sequence.localeCompare(right.sequence),
);

const relayBundleTransactions = dynamic.transactions.filter(
  (transaction) =>
    bundleSequence(transaction) ===
    "XPlace Program 2:Withdraw -> Relay Bridge:DepositToken",
);
const relayUsdcDeposited = relayBundleTransactions.reduce(
  (total, transaction) =>
    total +
    transaction.transfers
      .filter(
        (transfer) =>
          transfer.sourceRole === "XPLACE2_PDA" &&
          transfer.mint === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      )
      .reduce((transactionTotal, transfer) => transactionTotal + (transfer.ui ?? 0), 0),
  0,
);

const routedProgramIds = new Set(
  dynamic.programs
    .filter(
      (program) =>
        program.parents?.[JUPITER] > 0 ||
        ["Jupiter V6", "Jupiter Referral", "Meteora Vault"].includes(program.label),
    )
    .map((program) => program.programId),
);

const helperPrograms = dynamic.programs
  .filter(
    (program) =>
      ![
        XPLACE_1,
        XPLACE_2,
        "ComputeBudget111111111111111111111111111111",
        "11111111111111111111111111111111",
        "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
        "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
        "AddressLookupTab1e1111111111111111111111111",
      ].includes(program.programId),
  )
  .map((program) => ({
    programId: program.programId,
    label: program.label,
    relationship:
      program.programId === RELAY_BRIDGE
        ? "top_level_atomic_bundle_after_xplace2_withdraw"
        : [KAMINO_LENDING, KAMINO_FARMS].includes(program.programId)
          ? "direct_cpi_from_xplace1"
          : program.programId === KAMINO_SCOPE
            ? "top_level_oracle_refresh_before_xplace1"
            : routedProgramIds.has(program.programId)
              ? "jupiter_routed_cpi_or_route_helper"
              : "observed_helper_program",
    transactions: program.transactions,
    invocations: program.invocations,
    topLevelInvocations: program.topLevel,
    innerInvocations: program.inner,
    decodedInstructions: program.instructions,
    parents: program.parents,
    examples: program.examples.slice(0, 3),
    ownershipInterpretation:
      routedProgramIds.has(program.programId)
        ? "A routed CPI proves use as swap-path liquidity, not a persistent CH-owned LP position."
        : "Program participation does not by itself make its vaults or user positions CH-owned.",
  }));

const relayHelper = helperPrograms.find((program) => program.programId === RELAY_BRIDGE);
if (relayHelper) {
  relayHelper.currentBinarySha256 =
    "93a89aef6dd30e66f4cda6d3dafecddbfe58ecc98e5596dbc832feaf5eed9e91";
  relayHelper.binarySurface = [
    "Initialize",
    "SetAllocator",
    "SetOwner",
    "MigrateDomainSeparator",
    "DepositNative",
    "DepositToken",
    "ExecuteTransfer",
  ];
  relayHelper.recentUsdcDeposited = normalizeCount(relayUsdcDeposited);
  relayHelper.guardrails = [
    "allocator signer",
    "ed25519 request verification",
    "signature expiry",
    "domain separator",
    "recipient/mint/vault validation",
    "replay and reentrancy checks",
  ];
}

helperPrograms.push({
  programId: CCTP_BRIDGE,
  label: "XPlace CCTP Bridge Program",
  relationship: "token_recipient_owner_in_xplace2_repay_settlement",
  transactions: flowByKey.get(`${XPLACE_2}:RepayByWorker`)?.transactions ?? 0,
  invocations: 0,
  topLevelInvocations: 0,
  innerInvocations: 0,
  decodedInstructions: {},
  parents: {},
  examples: flowByKey.get(`${XPLACE_2}:RepayByWorker`)?.examples.slice(0, 3) ?? [],
  currentBinarySha256: "4044c16d7ad4c06b6a41e80a736b1d9bc12236af589b39cf1799ba4f7d2e3315",
  binarySurface: [
    "InitializeConfig",
    "UpdateConfig",
    "ProposeUpdateAuthority",
    "CommitUpdateAuthority",
    "Settle",
    "Bridge",
  ],
  recentUsdcToProgramOwnedRecipient: normalizeCount(
    flowByKey.get(`${XPLACE_2}:RepayByWorker`)?.netRoleDeltas[
      "PDA:CCTP Bridge Program|USDC"
    ] ?? 0,
  ),
  ownershipInterpretation:
    "The recent transactions transfer USDC into a token account owned by this bridge program; the bridge program itself is not invoked in those same transactions, so the transfer is settlement input rather than proof of an inline cross-chain completion.",
});

helperPrograms.sort(
  (left, right) =>
    right.transactions - left.transactions || left.label.localeCompare(right.label),
);

const recentWindowTimes = dynamic.transactions.map((transaction) => transaction.blockTime);
const recentWindow = {
  strategy: `latest ${decodedWindowCountLabel} address-referencing transactions fully decoded with log-stack CPI frames`,
  transactions: dynamic.capturedTransactions,
  successfulTransactions: dynamic.transactions.filter((transaction) => transaction.success).length,
  failedTransactions: dynamic.transactions.filter((transaction) => !transaction.success).length,
  fromUtc: new Date(Math.min(...recentWindowTimes) * 1000).toISOString(),
  toUtc: new Date(Math.max(...recentWindowTimes) * 1000).toISOString(),
  programIdsObserved: dynamic.programs.length,
  xplaceMethodsObserved: dynamic.flows.length,
  caveat:
    "Counts and volumes describe this decoded window, not all 202,066 historical signatures. Failed transactions contribute method attempts but no finalized state transition.",
};

const historyCoverage = {
  finalizedSignaturesEnumerated: 202066,
  fromUtc: "2025-10-31T16:07:48.000Z",
  toUtc: "2026-07-23T16:10:51.000Z",
  successfulSignatures: 197047,
  failedSignatures: 5019,
  complete: true,
  paginationTerminatedWithEmptyPage: true,
  oldestSignature:
    "4GZXP5dgiB7J7pzkzFbLcCabYwo75gc9UVwK4fpRa75WSSHGdBzcenBhjgbFgizxQ76Wah428MZABMbHp1575qB6",
  newestSignature:
    "44JmyxHKxyHqARnVxb6eWoH8w4MJjwrsNbyBWku4vwgBk3CKdKDpWtbPYH2gk7766DmELFTh3mGMNXAhbVyvBVFE",
  snapshotSemantics:
    "Complete for this address as of newestSignature/toUtc; later transactions can naturally appear after the snapshot.",
};

const capabilityArtifact = {
  schemaVersion: 1,
  generatedAt,
  chain: "solana",
  network: "mainnet-beta",
  account: ACCOUNT,
  evidenceTiers: {
    observed_recent_window:
      `Decoded finalized transaction with signer layout, logs, CPI stack and token deltas in the ${decodedWindowCountLabel}-transaction window.`,
    observed_legacy_stratified_sample:
      `Decoded finalized transaction in the earlier temporal-stratified sample but outside the latest ${decodedWindowCountLabel} window.`,
    binary_surface_only:
      "Method label/source symbols and validation strings in the current on-chain ProgramData binary; no recent execution proof.",
    inferred:
      "Structural interpretation from account layout, owner relationships or atomic correlation; explicitly marked and not treated as authority proof.",
  },
  historyCoverage,
  decodedRecentWindow: recentWindow,
  stateInventory: {
    xplace1: {
      programId: XPLACE_1,
      decodedAccountTypes: {
        d3218810ba6ef27f: "UserAccount",
        "29f2f170942f78f3": "UserId",
        "3a78d6c70ad6eaf4": "LoanSnapshot",
        "9a72675d4d3950e3": "UserCounter",
        ad536a8c02405d72: "RotationState",
        "9b0caae01efacc82": "Config",
      },
      ...stateInventory.xplace1,
      interpretation:
        "The 5,066 UserAccount records are per-user XPlace state. Their lamports and protocol positions are not direct CH funds. The 1,886 links matching current XPlace 2 CardAccount records are a snapshot join; unmatched links can reflect inactive/migrated/versioned card state.",
    },
    xplace2: {
      programId: XPLACE_2,
      decodedAccountTypes: {
        "3df0d4155e7c77c4": "CardAccount",
        f94448f737cee05d: "SubscriptionStatus",
        ad536a8c02405d72: "RotationState",
        "9b0caae01efacc82": "Config",
      },
      ...stateInventory.xplace2,
      interpretation:
        "The 3,168 CardAccount records encode per-card limits/state and are not direct CH balances.",
    },
  },
  currentFundsAndAttribution: {
    directWallet: mainMap.funds.direct,
    directTokenAccounts: {
      count: mainMap.funds.tokens.length,
      nonZeroCount: mainMap.funds.tokens.filter((token) => Number(token.amount) > 0).length,
      ledgerArtifact: "artifacts/solana/ch-account-funds.csv",
    },
    xplace2ConfigVault: mainMap.funds.protocolAndProgram.xplaceProgram2,
    xplace1ConfigVault: mainMap.funds.protocolAndProgram.xplaceProgram1,
    directKamino: mainMap.funds.protocolAndProgram.kamino,
    directDrift: mainMap.funds.protocolAndProgram.drift,
    attributionRule:
      "Only the System balance and token accounts whose token owner is CH are direct CH funds. XPlace Config/PDA balances and XPlace-managed Kamino/Drift positions are program/user state governed by instruction constraints, not a free CH balance.",
  },
  exactKaminoCollateralWithdrawal: {
    signature: exactTransaction.signature,
    solscanUrl: `https://solscan.io/tx/${exactTransaction.signature}`,
    slot: exactTransaction.slot,
    blockTime: exactTransaction.blockTime,
    blockTimeUtc: new Date(exactTransaction.blockTime * 1000).toISOString(),
    success: exactTransaction.success,
    signers: exactTransaction.signers,
    signerConclusion:
      "The concrete 3.5 USDT withdrawal is a two-signer transaction: CH plus the XPlace user. It proves CH participation and fee-payer/operational authority, not an unconstrained CH-only withdrawal.",
    methodSequence: exactMethodSequence,
    accountRoles: {
      user: "GpfKa9WofAsH7oRbYMp7tNssM88EjhxyqWA6rPhgDcx8",
      xplace1UserAccountPda: "ERVJFZ2fr1HD3cY12GZJJeNs9S3wPfRmFfUaprXM2tyv",
      kaminoMarketAuthority: "9DrvZvyWh1HuAoZxvYWMvkf2XCzryCpGgHqrMjyDWpmo",
      finalUserUsdtAta: "FiztGA99jq6KDYiwWjcekj7HzUaHWikGftAdMjxSAic9",
      xplace1ProxyUsdtAta: "Bf23xTGNJmCwm2HMQx9ejeN1nVYjoySBVBM7nmQQAWgU",
      kaminoUsdtReserveLiquiditySupply: "2Eff8Udy2G2gzNcf2619AnTx3xM4renEv4QrHKjS1o9N",
      burnedCollateralReceiptAccount: "CTCpzgNbPwWQSYamu4ZomgFuHf8DUGwq8hSYWVLurSJD",
    },
    transfers: exactTransfers,
    interpretation:
      "This is Kamino lending-collateral redemption (burn reserve collateral receipt and withdraw underlying USDT), not removal of a persistent Jupiter/Orca/Raydium/Meteora LP position.",
  },
  methodCapabilityMatrix: methods,
  recentProtocolPrograms: helperPrograms,
  atomicFlowCorrelations: atomicBundles.slice(0, 75),
  recentHighSignalFundFlows: {
    xplace2RepaySettlement: {
      transactions: flowByKey.get(`${XPLACE_2}:RepayByWorker`)?.transactions,
      signerLayouts: flowByKey.get(`${XPLACE_2}:RepayByWorker`)?.signerLayouts,
      netRoleDeltas: normalizeObjectNumbers(
        flowByKey.get(`${XPLACE_2}:RepayByWorker`)?.netRoleDeltas,
      ),
    },
    xplace1WorkerBorrowKamino: {
      transactions: flowByKey.get(`${XPLACE_1}:BorrowByWorkerKamino`)?.transactions,
      signerLayouts: flowByKey.get(`${XPLACE_1}:BorrowByWorkerKamino`)?.signerLayouts,
      netRoleDeltas: normalizeObjectNumbers(
        flowByKey.get(`${XPLACE_1}:BorrowByWorkerKamino`)?.netRoleDeltas,
      ),
    },
    xplace1WithdrawKamino: {
      transactions: flowByKey.get(`${XPLACE_1}:WithdrawKamino`)?.transactions,
      signerLayouts: flowByKey.get(`${XPLACE_1}:WithdrawKamino`)?.signerLayouts,
      netRoleDeltas: normalizeObjectNumbers(
        flowByKey.get(`${XPLACE_1}:WithdrawKamino`)?.netRoleDeltas,
      ),
    },
    xplace2RelayDeposit: {
      transactions: relayBundleTransactions.length,
      signerLayouts:
        atomicBundles.find(
          (bundle) =>
            bundle.sequence ===
            "XPlace Program 2:Withdraw -> Relay Bridge:DepositToken",
        )?.signerLayouts ?? {},
      usdcDeposited: normalizeCount(relayUsdcDeposited),
    },
  },
  limitations: [
    `The full signature crawl is complete at signature level for the recorded snapshot, while instruction-level decoding is complete for the latest ${decodedWindowCountLabel} transactions plus an earlier stratified sample.`,
    "Binary method presence is not access proof. Access claims require a successful observed signer layout and remain limited by account, whitelist, token, oracle, balance, limit, downstream-program and atomic-bundle checks.",
    "Routed DEX AddLiquidity/Deposit/Withdraw CPIs can be transient swap mechanics. They are not counted as persistent CH liquidity positions without a CH-owned position/share/NFT account.",
    "XPlace-managed user collateral, debt, card balances and all program-owned rent are not added to CH direct net worth.",
    "Recent-window token deltas are flow volume, not current balances and not all-time volume.",
  ],
};

function csvEscape(value) {
  const text = value == null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toCsv(rows, columns) {
  return [
    columns.join(","),
    ...rows.map((row) => columns.map((column) => csvEscape(row[column])).join(",")),
  ].join("\n");
}

const methodCsvRows = methods.map((record) => ({
  program: record.program,
  program_id: record.programId,
  method: record.method,
  access_class: record.accessClass,
  evidence: record.evidence,
  recent_transactions: record.observed?.source ? 0 : (record.observed?.transactions ?? 0),
  recent_success: record.observed?.source ? 0 : (record.observed?.success ?? 0),
  recent_failed: record.observed?.source ? 0 : (record.observed?.failed ?? 0),
  one_signer_messages: record.observed?.signerLayouts?.["1"] ?? 0,
  two_signer_messages: record.observed?.signerLayouts?.["2"] ?? 0,
  one_signer_success: record.observed?.signerOutcomes?.["1:success"] ?? 0,
  one_signer_failed: record.observed?.signerOutcomes?.["1:failed"] ?? 0,
  two_signer_success: record.observed?.signerOutcomes?.["2:success"] ?? 0,
  two_signer_failed: record.observed?.signerOutcomes?.["2:failed"] ?? 0,
  ch_only_success_evidence: record.chOnlySuccessEvidence,
  ch_plus_user_evidence: record.chPlusUserEvidence,
  effect: record.effect,
  caveat: record.caveat,
}));

const bundleCsvRows = atomicBundles.slice(0, 75).map((bundle) => ({
  transactions: bundle.transactions,
  success: bundle.success,
  failed: bundle.failed,
  one_signer_messages: bundle.signerLayouts["1"] ?? 0,
  two_signer_messages: bundle.signerLayouts["2"] ?? 0,
  sequence: bundle.sequence,
  examples: bundle.examples.join(" "),
}));

const fundSnapshot = mainMap.funds.snapshot ?? {};
const directFunds = mainMap.funds.direct;
const protocolFunds = mainMap.funds.protocolAndProgram;
const solPrice =
  mainMap.funds.tokens.find(
    (token) => token.mint === "So11111111111111111111111111111111111111112",
  )?.usdPrice ?? 0;
const usdcPrice =
  mainMap.funds.tokens.find(
    (token) => token.mint === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  )?.usdPrice ?? 0;
const fundCsvRows = [
  {
    scope: "direct",
    program: "System Program",
    program_address: ACCOUNT,
    asset: "SOL",
    mint: "So11111111111111111111111111111111111111112",
    account: ACCOUNT,
    amount: directFunds.liquidSystemSol,
    usd_price: solPrice,
    usd_value: directFunds.liquidSystemSolUsd,
    access: "direct signer",
    slot: fundSnapshot.systemAccountSlot ?? "",
    notes: "liquid native balance",
  },
  ...mainMap.funds.tokens.map((token) => ({
    scope: "direct",
    program:
      token.program === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        ? "Token-2022"
        : "SPL Token",
    program_address: token.program,
    asset: token.symbol,
    mint: token.mint,
    account: token.tokenAccount,
    amount: token.amount,
    usd_price: token.usdPrice ?? "",
    usd_value: token.usdValue ?? "",
    access: "direct token owner",
    slot:
      token.program === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        ? (fundSnapshot.token2022AccountsSlot ?? "")
        : (fundSnapshot.legacyTokenAccountsSlot ?? ""),
    notes: `${token.isVerified ? "verified" : "unverified"}/${token.organicScoreLabel ?? "unknown"}`,
  })),
  {
    scope: "recoverable-rent",
    program: "SPL Token + Token-2022",
    program_address: "",
    asset: "SOL",
    mint: "",
    account: `${mainMap.funds.tokens.length} token accounts`,
    amount: directFunds.tokenAccountRentSol,
    usd_price: solPrice,
    usd_value: directFunds.tokenAccountRentUsdIndicative,
    access: "after empty+close",
    slot: "",
    notes: "not current liquid balance",
  },
  ...[
    ["XPlace Program 2", XPLACE_2, protocolFunds.xplaceProgram2],
    ["XPlace Program 1", XPLACE_1, protocolFunds.xplaceProgram1],
  ].flatMap(([program, programAddress, record]) =>
    (record.configOwnedTokenAccounts ?? []).map((account) => ({
      scope: "program-controlled",
      program,
      program_address: programAddress,
      asset:
        account.mint === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
          ? "USDC"
          : account.mint,
      mint: account.mint,
      account: account.tokenAccount,
      amount: account.amount,
      usd_price:
        account.mint === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
          ? usdcPrice
          : "",
      usd_value:
        account.mint === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
          ? roundNumber(Number(account.amount) * Number(usdcPrice))
          : "",
      access: "Config PDA; CH operational authority",
      slot: fundSnapshot.configVaultSlot ?? "",
      notes:
        Number(account.amount) === 0
          ? "program-controlled empty token account"
          : "constraint-bound; not direct CH balance",
    })),
  ),
  {
    scope: "protocol-position",
    program: "Kamino direct obligations/vaults/rewards",
    program_address: "",
    asset: "",
    mint: "",
    account: "",
    amount: 0,
    usd_price: "",
    usd_value: 0,
    access: "none found",
    slot: "",
    notes: "",
  },
  {
    scope: "protocol-position",
    program: "Drift direct User accounts",
    program_address: "",
    asset: "",
    mint: "",
    account: "",
    amount: 0,
    usd_price: "",
    usd_value: 0,
    access: "none found",
    slot: "",
    notes: "",
  },
  {
    scope: "protocol-position",
    program: "Orca/Raydium/Meteora direct LP positions",
    program_address: "",
    asset: "",
    mint: "",
    account: "",
    amount: 0,
    usd_price: "",
    usd_value: 0,
    access: "none found",
    slot: "",
    notes: "",
  },
];

fs.mkdirSync(outputDirectory, { recursive: true });
fs.writeFileSync(
  path.join(outputDirectory, "ch-cpi-capability-map.json"),
  `${JSON.stringify(capabilityArtifact, null, 2)}\n`,
);
fs.writeFileSync(
  path.join(outputDirectory, "ch-method-capabilities.csv"),
  `${toCsv(methodCsvRows, [
    "program",
    "program_id",
    "method",
    "access_class",
    "evidence",
    "recent_transactions",
    "recent_success",
    "recent_failed",
    "one_signer_messages",
    "two_signer_messages",
    "one_signer_success",
    "one_signer_failed",
    "two_signer_success",
    "two_signer_failed",
    "ch_only_success_evidence",
    "ch_plus_user_evidence",
    "effect",
    "caveat",
  ])}\n`,
);
fs.writeFileSync(
  path.join(outputDirectory, "ch-atomic-flow-correlations.csv"),
  `${toCsv(bundleCsvRows, [
    "transactions",
    "success",
    "failed",
    "one_signer_messages",
    "two_signer_messages",
    "sequence",
    "examples",
  ])}\n`,
);
fs.writeFileSync(
  path.join(outputDirectory, "ch-account-funds.csv"),
  `${toCsv(fundCsvRows, [
    "scope",
    "program",
    "program_address",
    "asset",
    "mint",
    "account",
    "amount",
    "usd_price",
    "usd_value",
    "access",
    "slot",
    "notes",
  ])}\n`,
);

const legacyDecodedSample = mainMap.legacyDecodedSample ?? mainMap.decodedSample;
mainMap.schemaVersion = 3;
mainMap.generatedAt = generatedAt;
mainMap.historyCoverage = historyCoverage;
mainMap.legacyDecodedSample = legacyDecodedSample;
mainMap.decodedSample = {
  ...recentWindow,
  observedMethodSignerLayouts: Object.fromEntries(
    dynamic.flows.map((flow) => [
      `${flow.program}:${flow.method}`,
      {
        transactions: flow.transactions,
        success: flow.success,
        failed: flow.failed,
        signerLayouts: flow.signerLayouts,
      },
    ]),
  ),
};
mainMap.xplaceStateInventory = capabilityArtifact.stateInventory;
mainMap.deepAnalysisArtifacts = {
  cpiCapabilityMap: "artifacts/solana/ch-cpi-capability-map.json",
  methodCapabilityMatrix: "artifacts/solana/ch-method-capabilities.csv",
  atomicFlowCorrelations: "artifacts/solana/ch-atomic-flow-correlations.csv",
  directFundLedger: "artifacts/solana/ch-account-funds.csv",
};
mainMap.programs = mainMap.programs.map((program) => {
  if (![XPLACE_1, XPLACE_2].includes(program.address)) return program;
  const recentMethods = Object.fromEntries(
    dynamic.flows
      .filter((flow) => flow.programId === program.address)
      .map((flow) => [
        flow.method,
        {
          transactions: flow.transactions,
          success: flow.success,
          failed: flow.failed,
          signerLayouts: flow.signerLayouts,
        },
      ]),
  );
  return {
    ...program,
    instructionSurface: {
      ...program.instructionSurface,
      observedRecentWindowSignerLayouts: recentMethods,
      capabilityMatrixArtifact: "artifacts/solana/ch-method-capabilities.csv",
    },
  };
});
mainMap.limitations = capabilityArtifact.limitations;
mainMap.sources = {
  ...mainMap.sources,
  solanaOfficialDocumentation: {
    getSignaturesForAddress: "https://solana.com/docs/rpc/http/getsignaturesforaddress",
    getTransaction: "https://solana.com/docs/rpc/http/gettransaction",
    jsonStructures: "https://solana.com/docs/rpc/json-structures",
  },
  currentOnChainBinaryHashes: {
    xplace1: "ff1c8445dc9c6ce287ccdaf5455654a87e0ce5dcde2984882bc119604aafaaa5",
    xplace2: "69e96442df0248956c564d3f2d0870596744da400f3c53d01c16573478de5259",
    cctpBridge: "4044c16d7ad4c06b6a41e80a736b1d9bc12236af589b39cf1799ba4f7d2e3315",
    relayBridge: "93a89aef6dd30e66f4cda6d3dafecddbfe58ecc98e5596dbc832feaf5eed9e91",
  },
};
fs.writeFileSync(mainMapPath, `${JSON.stringify(mainMap, null, 2)}\n`);

console.log(
  JSON.stringify(
    {
      generatedAt,
      methods: methods.length,
      helperPrograms: helperPrograms.length,
      atomicBundles: atomicBundles.length,
      recentTransactions: recentWindow.transactions,
      outputs: [
        path.join(outputDirectory, "ch-cpi-capability-map.json"),
        path.join(outputDirectory, "ch-method-capabilities.csv"),
        path.join(outputDirectory, "ch-atomic-flow-correlations.csv"),
        path.join(outputDirectory, "ch-account-funds.csv"),
        mainMapPath,
      ],
    },
    null,
    2,
  ),
);

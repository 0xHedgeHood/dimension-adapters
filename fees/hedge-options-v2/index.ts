import { FetchOptions, SimpleAdapter } from '../../adapters/types';
import { CHAIN } from '../../helpers/chains';

// HedgeHood EuropeanCallOrderBook deployments on Robinhood Chain.
// Product: https://hedgehood.app/options | https://docs.hedgehood.app/hedge
// Maintained deployment set checked on 2026-09-24, including the retired/misdated
// series. New expiries require adding their orderbooks; never remove expired ones.
// All books settle in the canonical 6-decimal USDG. The immutable protocol fee
// goes directly to the configured recipient during fillOrder, not on a later claim.
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const ORDERBOOKS = [
  '0x80eefbC9A8F9436f619b56e0Ce8126Ff85960614', // nvda-215-20260925
  '0xF9d619f47c344398ED93A92711e9aA0EB85D2FF9', // googl-345-20260925
  '0xccE941383B1383A4a9770cDAE26deDCCDfa5e9D9', // tsla-360-20260925
  '0x7e70dC75E8F8eCf13b30525aD53A26B7bAF03c5a', // gme-22-20260925
  '0x7aBa715cF2ba4362968B17DbdB53699057Ae7E8c', // nvda-215-20260918
  '0x2c8456C792FB1de6d2a4C22D28dea9810B77C0f9', // nvda-220-20261002
  '0x22e5AecAC4Ff79e80497cAD8d4fdC7B62Ec57Ffe', // googl-345-20261002
  '0xB8D00917836F22174cd0052294f37d3A93F98C78', // tsla-365-20261002
  '0x6b5129884180f2a5E8cEdbb5b87D31991572375C', // gme-22.5-20261002
  '0xdc835c495B6355698412949287661a725480bc0b', // nvda-220-20261009
  '0x2c12dE07cEaf24eB9C93b739d99b74C67872755b', // googl-345-20261009
  '0x44297C6440cA6159D867dEC37abEcF24B1F880E9', // tsla-365-20261009
  '0x28E63882B32cA9CA05cD95bCf97E3dd8341d346E', // gme-22.5-20261009
  '0xc11E176D92a8610E51218f9b52968CdA9Cd7c35e', // Retired misdated series, actual expiry 2026-09-23; retain its history.
];
// Confirmed operator acceptance trade funded between protocol-controlled wallets.
// Its on-chain fee is an internal test transfer, not external protocol income.
const INTERNAL_ACCEPTANCE_TRANSACTIONS = new Set([
  '0x2ac20728bc3127e9018b1e6e788256abb411baaaa6420dbac400915f9eba0fa8',
]);
const ORDER_FILLED = 'event OrderFilled(bytes32 indexed digest, address indexed maker, address indexed taker, uint8 side, address makerRecipient, uint256 longAmountRaw, uint256 premiumTotalRaw, uint256 protocolFeeRaw, uint256 sellerPremiumRaw, uint256 stockMultiplier, uint256 nonce)';

const fetch = async (options: FetchOptions) => {
  const dailyFees = options.createBalances();
  const dailyRevenue = options.createBalances();
  // The opening block is the preceding snapshot; exclude it so adjacent
  // hourly windows cannot count the same boundary event twice.
  const previousBlock = await options.getFromBlock();
  const toBlock = await options.getToBlock();
  if (!Number.isSafeInteger(previousBlock) || previousBlock < 0
    || !Number.isSafeInteger(toBlock) || toBlock < previousBlock)
    throw new Error('Hedge options: missing or invalid window blocks');
  const fromBlock = previousBlock + 1;
  const logs = toBlock === previousBlock ? []
    : await options.getLogs({ targets: ORDERBOOKS, eventAbi: ORDER_FILLED, fromBlock, toBlock, onlyArgs: false });
  for (const log of logs) {
    if (typeof log.transactionHash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(log.transactionHash) || !log.args)
      throw new Error('Hedge options: missing transaction identity or decoded arguments');
    if (INTERNAL_ACCEPTANCE_TRANSACTIONS.has(log.transactionHash.toLowerCase())) continue;
    const fee = BigInt(log.args.protocolFeeRaw);
    const premium = BigInt(log.args.premiumTotalRaw);
    const sellerPremium = BigInt(log.args.sellerPremiumRaw);
    if (fee < 0n || sellerPremium < 0n || premium <= 0n || fee + sellerPremium !== premium)
      throw new Error('Hedge options: inconsistent premium and fee allocation');
    // The premium buys the option; only the separately emitted marketplace
    // charge is a service fee. Never count the seller's option sale proceeds.
    dailyFees.add(USDG, fee, 'Option trading fees');
    dailyRevenue.add(USDG, fee, 'Option trading fees to treasury');
  }
  return { dailyFees, dailyRevenue, dailyProtocolRevenue: dailyRevenue.clone() };
};

const protocolBreakdown = {
  'Option trading fees to treasury': 'The exact protocolFeeRaw paid to each orderbook fee recipient at settlement; no premium sale proceeds or subsequent treasury transfers.',
};
const adapter: SimpleAdapter = {
  version: 2,
  pullHourly: true,
  chains: [CHAIN.ROBINHOOD],
  start: '2026-09-16', // First orderbook activity (internal acceptance is excluded): 0x2ac20728bc3127e9018b1e6e788256abb411baaaa6420dbac400915f9eba0fa8.
  fetch,
  // Legacy CoveredCall at 0xec2aaa96fc67ad92fa0ca8c602e51c035227e238
  // has no platform fee: its two historical fills credited the whole premium
  // to the seller. Exclude these premiums, exercise payments and claim transfers.
  methodology: {
    Fees: 'Marketplace charges paid on European option trades, measured from the emitted protocol fee. Excludes confirmed internal acceptance trades, option premiums, collateral, exercise payments and legacy CoveredCall trades, which charged no platform fee.',
    Revenue: 'All option marketplace charges accrue to the designated protocol fee recipient; sellers receive option sale proceeds separately.',
    ProtocolRevenue: 'The same option trading charges paid directly to the protocol treasury; later transfers or distributions are not counted again.',
  },
  breakdownMethodology: {
    Fees: { 'Option trading fees': 'Actual protocolFeeRaw from eligible OrderFilled events, excluding confirmed internal acceptance transfers and preserving the contract rounding and USDG raw units; not inferred from premium volume or a fixed rate.' },
    Revenue: protocolBreakdown,
    ProtocolRevenue: protocolBreakdown,
  },
};

export default adapter;

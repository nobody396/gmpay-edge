interface AssetToken {
	address?: string;
	chain: string;
	kind?: "native" | "token";
	logoURI?: string;
	symbol?: string;
}

const repository = "GMWalletApp/assets";
const branch = "main";
const cdns = [
	`https://cdn.jsdmirror.com/gh/${repository}@${branch}`,
	`https://cdn.jsdelivr.net/gh/${repository}@${branch}`,
	`https://fastly.jsdelivr.net/gh/${repository}@${branch}`,
	`https://raw.githubusercontent.com/${repository}/${branch}`,
] as const;
const tokenLists = cdns.map(
	(base) => `${base}/extensions/jsonrpc/data/tokenlist.json.zst`,
);
const networkAliases: Record<string, string> = {
	bsc: "smartchain",
	"bnb-smart-chain": "smartchain",
	binance: "smartchain",
	eth: "ethereum",
	trc20: "tron",
};
const canonicalSymbolAssets: Record<
	string,
	{ network: string; contractAddress?: string }
> = {
	APT: { network: "aptos" },
	BNB: { network: "smartchain" },
	ETH: { network: "ethereum" },
	GRAM: { network: "ton" },
	MATIC: { network: "polygon" },
	POL: { network: "polygon" },
	SOL: { network: "solana" },
	TON: { network: "ton" },
	USDC: {
		network: "ethereum",
		contractAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
	},
	USDT: {
		network: "ethereum",
		contractAddress: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
	},
	TRX: { network: "tron" },
};
let tokenListRequest: Promise<AssetToken[]> | undefined;

function normalizeAssetNetwork(value?: string) {
	const normalized = value?.trim().toLowerCase().replaceAll(" ", "-") ?? "";
	return networkAliases[normalized] ?? normalized;
}

export function repositoryIconUrls(
	network: string,
	contractAddress?: string | null,
) {
	const chain = normalizeAssetNetwork(network);
	if (!chain) return [];
	if (chain === "xlayer" && !contractAddress?.trim())
		return ["/icons/xlayer.svg"];
	const path = contractAddress?.trim()
		? `blockchains/${chain}/assets/${contractAddress.trim()}/logo.png`
		: `blockchains/${chain}/info/logo.png`;
	return cdns.map((base) => `${base}/${path}`);
}

export function symbolIconUrls(symbol?: string) {
	const asset = canonicalSymbolAssets[symbol?.trim().toUpperCase() ?? ""];
	return asset ? repositoryIconUrls(asset.network, asset.contractAddress) : [];
}

export function directAssetIconUrls({
	contractAddress,
	network,
	networkIndependent = false,
	symbol,
}: {
	contractAddress?: string | null;
	network: string;
	networkIndependent?: boolean;
	symbol?: string;
}) {
	if (networkIndependent || (!contractAddress?.trim() && symbol)) {
		return symbolIconUrls(symbol);
	}
	return repositoryIconUrls(network, contractAddress);
}

export function providerIconUrls(
	kind: "exchange" | "wallet",
	provider: string,
) {
	const directory = kind === "exchange" ? "exchanges" : "wallets";
	const id = provider.trim().toLowerCase();
	if (!id) return [];
	return cdns.map((base) => `${base}/support/${directory}/${id}/logo.svg`);
}

export async function resolveCatalogAssetIconUrls({
	contractAddress,
	network,
	networkIndependent = false,
	symbol,
}: {
	contractAddress?: string | null;
	network: string;
	networkIndependent?: boolean;
	symbol?: string;
}) {
	const chain = normalizeAssetNetwork(network);
	const address = normalize(contractAddress);
	const normalizedSymbol = normalize(symbol);
	const tokens = await getTokenList();
	const candidates = tokens.filter((token) => {
		if (!token.logoURI) return false;
		return networkIndependent
			? normalize(token.symbol) === normalizedSymbol
			: normalizeAssetNetwork(token.chain) === chain;
	});
	const matched = address
		? candidates.find((token) => normalize(token.address) === address)
		: ((networkIndependent
				? preferredSymbolCandidate(candidates, normalizedSymbol)
				: normalizedSymbol
					? candidates.find(
							(token) => normalize(token.symbol) === normalizedSymbol,
						)
					: undefined) ?? candidates.find((token) => token.kind === "native"));
	return uniqueUrls(matched?.logoURI ? mirrorLogoUrls(matched.logoURI) : []);
}

function preferredSymbolCandidate(
	candidates: AssetToken[],
	normalizedSymbol: string,
) {
	const preferredNetwork =
		canonicalSymbolAssets[normalizedSymbol.toUpperCase()]?.network;
	return (
		candidates.find(
			(token) => normalizeAssetNetwork(token.chain) === preferredNetwork,
		) ?? candidates[0]
	);
}

async function getTokenList() {
	tokenListRequest ??= loadTokenList();
	return tokenListRequest;
}

async function loadTokenList() {
	for (const url of tokenLists) {
		try {
			const response = await fetch(url, {
				signal: AbortSignal.timeout(5_000),
			});
			if (!response.ok) continue;
			const [{ decompress }, buffer] = await Promise.all([
				import("fzstd"),
				response.arrayBuffer(),
			]);
			const compressed = new Uint8Array(buffer);
			const data = JSON.parse(
				new TextDecoder().decode(decompress(compressed)),
			) as {
				tokens?: AssetToken[];
			};
			return data.tokens ?? [];
		} catch {
			// Continue with the next assets-web compatible CDN.
		}
	}
	return [];
}

function mirrorLogoUrls(logo: string) {
	const urls = [logo];
	try {
		const parsed = new URL(logo);
		if (parsed.hostname === "assets-cdn.trustwallet.com")
			urls.unshift(
				`https://cdn.jsdmirror.com/gh/trustwallet/assets@master${parsed.pathname}`,
			);
		if (parsed.hostname === "cdn.jsdelivr.net")
			urls.unshift(`https://cdn.jsdmirror.com${parsed.pathname}`);
	} catch {
		// Keep the original logo URI.
	}
	return urls;
}

function normalize(value?: string | null) {
	return value?.trim().toLowerCase() ?? "";
}

function uniqueUrls(urls: string[]) {
	return [...new Set(urls.filter(Boolean))];
}

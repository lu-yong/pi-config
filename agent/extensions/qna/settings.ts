/**
 * qna 扩展的配置解析 — 纯逻辑，零 import（连 node 内置模块都不引），读盘留给 index.ts 这层适配器。
 *
 * 配置位置: ~/.pi/agent/settings.json 顶层的 "qna" 键。
 * 顶层按扩展名开一个块是本机 settings.json 已有的约定（见 "observational-memory"），
 * 抽取模型的 { provider, id, thinking } 形状也照抄它，避免再发明一套。
 *
 * 全部字段都是可选的：文件缺失、JSON 损坏、类型不对，一律降级到默认值，绝不抛异常 ——
 * 配置出问题不能让 /qna 不可用。
 */

export const QNA_SETTINGS_KEY = "qna";

/** 自动触发默认开启，保持改造前的行为 */
export const DEFAULT_AUTO_EXTRACT = true;

/** 与 pi-ai 的 ThinkingLevel 对齐；这里重新声明是为了守住零 import */
export const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type QnaThinkingLevel = (typeof THINKING_LEVELS)[number];

/** settings.json 里 qna.model 的形状 */
export interface QnaModelRef {
	provider: string;
	id: string;
	thinking: QnaThinkingLevel | null;
	/** thinking 字段存在但取值不合法 —— 需要提示，不能当没看见 */
	invalidThinking: boolean;
}

export interface QnaSettings {
	autoExtract: boolean;
	/** 未配置或配置不合法时为 null，表示沿用主模型 */
	model: QnaModelRef | null;
	/**
	 * qna.model 这个键是否写了东西。用来区分"根本没配"（默认路径，不提示）
	 * 和"配了但不合法"（要提示），两种情况的 model 都是 null。
	 */
	modelConfigured: boolean;
}

export function defaultQnaSettings(): QnaSettings {
	return { autoExtract: DEFAULT_AUTO_EXTRACT, model: null, modelConfigured: false };
}

function normalizeThinking(value: unknown): { thinking: QnaThinkingLevel | null; invalid: boolean } {
	if (value === undefined || value === null) return { thinking: null, invalid: false };
	if (typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value)) {
		return { thinking: value as QnaThinkingLevel, invalid: false };
	}
	return { thinking: null, invalid: true };
}

/**
 * qna.model 的规范化。provider / id 缺失或类型不对时返回 null（调用方据此回退到主模型）。
 * thinking 非法只是丢掉 thinking，不牵连模型本身 —— 模型引用本身是好的。
 */
export function normalizeQnaModelRef(value: unknown): QnaModelRef | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	const provider = typeof raw.provider === "string" ? raw.provider.trim() : "";
	const id = typeof raw.id === "string" ? raw.id.trim() : "";
	if (!provider || !id) return null;
	const { thinking, invalid } = normalizeThinking(raw.thinking);
	return { provider, id, thinking, invalidThinking: invalid };
}

/** 从已解析的 settings.json 值里取 qna 块；任何形状异常都降级到默认值 */
export function normalizeQnaSettings(value: unknown): QnaSettings {
	if (!value || typeof value !== "object") return defaultQnaSettings();
	const section = (value as Record<string, unknown>)[QNA_SETTINGS_KEY];
	if (!section || typeof section !== "object" || Array.isArray(section)) return defaultQnaSettings();
	const raw = section as Record<string, unknown>;
	const rawModel = raw.model;
	return {
		autoExtract: typeof raw.autoExtract === "boolean" ? raw.autoExtract : DEFAULT_AUTO_EXTRACT,
		model: normalizeQnaModelRef(rawModel),
		modelConfigured: rawModel !== undefined && rawModel !== null,
	};
}

/**
 * settings.json 文本 -> qna 配置。传 undefined 表示文件读不到。
 * JSON 损坏在这里被吞掉，调用方永远拿到一份可用的配置。
 */
export function parseQnaSettings(rawJson: string | undefined): QnaSettings {
	if (typeof rawJson !== "string" || rawJson.trim() === "") return defaultQnaSettings();
	try {
		return normalizeQnaSettings(JSON.parse(rawJson));
	} catch {
		return defaultQnaSettings();
	}
}

// ---- 抽取模型的解析与回退 ----

export interface ResolvedExtractionModel<TModel> {
	model: TModel;
	thinking: QnaThinkingLevel | null;
	/** true 表示用的是主模型（没配，或配了但用不了） */
	usedFallback: boolean;
	/** 需要让用户看见的提示；未配置抽取模型属于正常路径，为 null */
	notice: string | null;
}

export interface ResolveExtractionModelOptions<TModel> {
	settings: QnaSettings;
	/** ctx.model —— 任何解析失败的兜底 */
	mainModel: TModel;
	/** 主模型 id，仅用于提示文案 */
	mainModelId: string;
	/** ctx.modelRegistry.find */
	find: (provider: string, id: string) => TModel | undefined;
	/** ctx.modelRegistry.hasConfiguredAuth */
	hasAuth: (model: TModel) => boolean;
}

/**
 * 决定这次抽取用哪个模型。纯函数：查表和鉴权都由调用方注入。
 *
 * 配置缺失、字段不全、模型不在目录里、拿不到 API key —— 全部回退到主模型，
 * 且除"根本没配"之外都带一条可见提示，不做静默降级。
 */
export function resolveExtractionModel<TModel>(
	options: ResolveExtractionModelOptions<TModel>,
): ResolvedExtractionModel<TModel> {
	const { settings, mainModel, mainModelId, find, hasAuth } = options;
	const fallback = (notice: string | null): ResolvedExtractionModel<TModel> => ({
		model: mainModel,
		thinking: null,
		usedFallback: true,
		notice,
	});

	const ref = settings.model;
	if (!ref) {
		// 区分"没写 model"（默认路径，不打扰用户）和"写了但不合法"（必须提示）。
		return fallback(settings.modelConfigured ? incompleteNotice(mainModelId) : null);
	}

	const label = `${ref.provider}/${ref.id}`;
	const found = find(ref.provider, ref.id);
	if (!found) return fallback(`qna.model 指定的 ${label} 不在可用模型目录里，本次抽取回退到主模型 ${mainModelId}`);
	if (!hasAuth(found)) return fallback(`qna.model 指定的 ${label} 没有可用的 API key，本次抽取回退到主模型 ${mainModelId}`);

	return {
		model: found,
		thinking: ref.thinking,
		usedFallback: false,
		notice: ref.invalidThinking
			? `qna.model.thinking 取值无效（可选 ${THINKING_LEVELS.join(" / ")}），本次抽取不指定 thinking`
			: null,
	};
}

function incompleteNotice(mainModelId: string): string {
	return `qna.model 配置不完整（需要 provider 和 id 两个非空字符串），本次抽取回退到主模型 ${mainModelId}`;
}

/** 抽取模型解析失败但已经拿到 model 对象后才发现取不到 key 时的提示 */
export function authFallbackNotice(modelLabel: string, mainModelId: string): string {
	return `抽取模型 ${modelLabel} 取不到 API key，本次抽取回退到主模型 ${mainModelId}`;
}

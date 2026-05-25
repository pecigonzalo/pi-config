export type CodeIntelAction = "repo_map" | "status" | "outline" | "symbols" | "slice" | "enclosing_symbol";

export interface CodeIntelParams {
	action: CodeIntelAction;
	root?: string;
	mapTokens?: number;
	maxFiles?: number;
	maxFileBytes?: number;
	include?: string[];
	exclude?: string[];
	query?: string;
	path?: string;
	symbol?: string;
	line?: number;
	column?: number;
	limit?: number;
	sliceMode?: "implementation" | "declaration" | "any";
}

export interface SourceFile {
	absPath: string;
	relPath: string;
	language: string;
	size: number;
	mtimeMs?: number;
}

export interface Definition {
	name: string;
	kind: string;
	file: string;
	line: number; // zero-based
	column: number;
	text: string;
	signatureLines: string[];
	score: number;
	backend?: "tree-sitter-tags" | "syntax-pattern";
	declaration?: boolean;
	container?: string;
}

export interface RepoMapOptions {
	root?: string;
	mapTokens?: number;
	maxFiles?: number;
	maxFileBytes?: number;
	include?: string[];
	exclude?: string[];
	query?: string;
	path?: string;
	symbol?: string;
	line?: number;
	column?: number;
	limit?: number;
	sliceMode?: "implementation" | "declaration" | "any";
}

export interface SourceScanDiagnostics {
	unsupportedExtensions: Map<string, number>;
	fallbackPatternLanguages: Map<string, number>;
	treeSitterTagsAvailable?: boolean;
	treeSitterTaggedFiles?: number;
	treeSitterTagDefinitions?: number;
	treeSitterTagReferences?: number;
	treeSitterTagsError?: string;
}

export interface SourceDiscoveryResult {
	files: SourceFile[];
	diagnostics: SourceScanDiagnostics;
}

export interface RepoFileAnalysis {
	file: SourceFile;
	definitions: Definition[];
	references: Map<string, number>;
	text?: string;
}

export interface RepoAnalysis {
	root: string;
	files: SourceFile[];
	diagnostics: SourceScanDiagnostics;
	analyses: RepoFileAnalysis[];
	definitionsByName: Map<string, Definition[]>;
	referencesByName: Map<string, Map<string, number>>;
	rankedDefinitions: Definition[];
}

export interface CodeIntelDetails {
	action?: CodeIntelAction;
	summary: string;
	lineCount: number;
	byteCount: number;
	firstLine?: string;
}

export interface TreeSitterFileTags {
	definitions: TreeSitterTag[];
	references: Map<string, number>;
}

export interface TreeSitterTag {
	name: string;
	kind: string;
	role: "def" | "ref";
	file: string;
	line: number;
	column: number;
	text?: string;
}

export interface CachedAnalysisFile {
	file: SourceFile;
	definitions: Definition[];
	references: Array<[string, number]>;
}

export interface CachedAnalysisPayload {
	version: number;
	root: string;
	backendSignature: string;
	fileSignature: string;
	diagnostics: {
		unsupportedExtensions: Array<[string, number]>;
		fallbackPatternLanguages: Array<[string, number]>;
		treeSitterTagsAvailable?: boolean;
		treeSitterTaggedFiles?: number;
		treeSitterTagDefinitions?: number;
		treeSitterTagReferences?: number;
	};
	analyses: CachedAnalysisFile[];
}

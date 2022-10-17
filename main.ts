import { link } from "fs";
import { url } from "inspector";
import {
	Plugin,
	EventRef,
	TFile,
	ReferenceCache,
	MetadataCache,
} from "obsidian";

// While debugging, can access the object directly
// app.plugins.plugins["obsidian-sample-plugin"].backlinks;
// I'm not sure what I get with the second reloads...

declare module "obsidian" {
	interface MetadataCache {
		initialized: boolean;
		initialize(): void;
		fileCache: {
			[filePath: string]: { hash: string; mtime: number; size: number };
		};
		uniqueFileLookup: {
			data: { [baseName: string]: TFile[] };
			add(key: string, value: TFile): void;
		};
		metadataCache: { [hash: string]: CachedMetadata };
		linkResolverQueue: { add(file: TFile): void };
		getLinkSuggestions(): any[];
		getLinks(): ReferenceCache[];
	}
}

export interface IBacklinks {
	redirects: { [key: string]: string };
	url_info: IURLInfoMap;
	markdown_map: IURLInfoMap;
}

export interface IURLInfoMap {
	[key: string]: IURLInfo;
}

// Call this method inside your plugin's
// `onload` function like so:
// monkeyPatchConsole(this);
const monkeyPatchConsole = (plugin: Plugin) => {
	//	if (this.Platform.isMobile) { return; }

	const logFile = `${plugin.manifest.dir}/logs.txt`;
	const logs: string[] = [];
	const logMessages =
		(prefix: string) =>
		(...messages: unknown[]) => {
			logs.push(`\n[${prefix}]`);
			for (const message of messages) {
				logs.push(String(message));
			}
			plugin.app.vault.adapter.write(logFile, logs.join(" "));
		};

	console.debug = logMessages("debug");
	console.error = logMessages("error");
	console.info = logMessages("info");
	console.log = logMessages("log");
	console.warn = logMessages("warn");
};

export interface IURLInfo {
	url: string;
	title: string;
	description: string;
	file_path: string;
	markdown_path: string;
	outgoing_links: string[];
	incoming_links: string[];
	redirect_url: string;
	doc_size: number;
}

export default class RelBuilderPlugin extends Plugin {
	private resolved: EventRef;
	private resolve: EventRef;
	private backlinks: IBacklinks;

	fixup_links(srcFile: any) {
		const filePath = srcFile.path;
		let urlName = filePath.split("oblog/")[1];
		if (!urlName) {
			// Not part of blog just return
			return;
		}
		console.log("Fixing up:", urlName);

		//  Now, for this file, lets update all the links
		let links: [ReferenceCache] = (app.metadataCache.getLinks() as any)[
			srcFile.path
		];

		// console.log("links", links);
		links.forEach((link) => {
			if (!link.link.startsWith("/")) {
				return;
			}
			console.log("Link To Replace", link.link);
			let redirect = this.backlinks.redirects[link.link];
			if (redirect) {
				const replace_link =
					"oblog/" + this.backlinks.url_info[redirect].markdown_path;
				console.log("Replacing", link.link, "with", replace_link);
				link.link = replace_link;
				return;
			}
			let direct_link = this.backlinks.url_info[link.link];
			if (direct_link) {
				const replace_link =
					"oblog/" + this.backlinks.url_info[link.link].markdown_path;
				console.log("Replacing", link.link, "with", replace_link);
				link.link = replace_link;
				return;
			}
			console.log("Couldn't find a redirect link for ", link.link);
		});

		const mdCache = this.app.metadataCache;
		const cache = mdCache.getFileCache(srcFile);
		let permalink = cache?.frontmatter?.permalink;
		console.log(permalink);
		// update the relevant link cache
		console.log("Resolved Links: ", mdCache.resolvedLinks[srcFile.path]);
		console.log(
			"Unresolved Links: ",
			mdCache.unresolvedLinks[srcFile.path]
		);
	}

	async onload() {
		// monkeyPatchConsole(this) -
		if (!this.app.metadataCache.initialized) {
			this.resolved = this.app.metadataCache.on("resolved", () => {
				this.app.metadataCache.offref(this.resolved);
				console.log("Ephemeral cache has completed priming.");
				// perform any logic that should only happen once the empheral cache has been primed
			});
		} else {
			console.log(
				"Plugin loaded after the ephemeral cache was primed a ."
			);
			// Perform any logic that would be needed due to missing the initial cache priming
			//
			// In this case, we'll do a full refresh on the link resolver cache so that we can have
			// a chance to act on all of the "resolve" events
			this.rebuildAllLinks();
		}

		// HACK - Hard code in from backlinks which are uploaded by an external python scrips
		// But hey, gotta start somewhere.
		let backlinks_ref = await app.vault
			.getFiles()
			.filter((file) => file.path == "oblog/back-links.json")[0];
		this.backlinks = JSON.parse(await app.vault.cachedRead(backlinks_ref));

		// Build the backlinks
		this.backlinks.markdown_map = {};
		Object.entries(this.backlinks.url_info).forEach((entry) => {
			const [key, value] = entry;
			this.backlinks.markdown_map[value.markdown_path] = value;
		});

		console.log(this.backlinks.url_info);
		// console.log(this.backlinks.redirects);

		this.registerEvent(
			// "resolve" is debounced by 2 seconds on any document change
			(this.resolve = this.app.metadataCache.on("resolve", (srcFile) => {
				this.fixup_links(srcFile);
			}))
		);
		this.addCommand({
			id: "rebuild-links",
			name: "Rebuild Jekyll Links",
			callback: () => {
				console.log("Running Rebuild!");
				this.rebuildAllLinks();
			},
		});
	}

	onunload(): void {
		// remove our resolve listener
		this.app.metadataCache.offref(this.resolve);
		// and refresh the cache so that our custom relationships are cleared out
		this.rebuildAllLinks();
	}

	incrementLinkRefCount(linkText: string, srcFile: TFile) {
		// borrowed most of this cache updating logic from @valentine195
		// reference: https://github.com/valentine195/obsidian-admonition/blob/b9ee5e1c084446b65d9c011b8d4b34569bbf72af/src/main.ts#L885
		//
		// update the relevant link resolver cache based on whether or not the linkText resolves to an actual file
		//2
		// junk
		const mdCache = this.app.metadataCache;
		let file = mdCache.getFirstLinkpathDest(linkText, "");
		let cache, path: string;
		if (file && file instanceof TFile) {
			cache = mdCache.resolvedLinks;
			path = file.path;
		} else {
			cache = mdCache.unresolvedLinks;
			path = linkText;
		}
		// initialize the source file key, if not found
		if (!cache[srcFile.path]) {
			cache[srcFile.path] = {
				[path]: 0,
			};
		}
		// initialize the target link key, if not found
		let resolved = cache[srcFile.path];
		if (!resolved[path]) {
			resolved[path] = 0;
		}
		// increment the target link value
		resolved[path] += 1;
		cache[srcFile.path] = resolved;
	}

	rebuildAllLinks = () => {
		// This will force a refresh of the link resolver cache
		// Logic was borrowed from the default Obsidian MetadataCache.initialize() method
		const mdCache = this.app.metadataCache;
		const metadataCache = mdCache.metadataCache;
		const fileCache = mdCache.fileCache;
		let markdownFiles: { [path: string]: TFile } = {};
		let allLoadedFiles = this.app.vault.getAllLoadedFiles();

		for (let file of allLoadedFiles) {
			if (file instanceof TFile) {
				mdCache.uniqueFileLookup.add(file.name.toLowerCase(), file);
				markdownFiles[file.path] = file;
			}
		}

		for (let filePath in fileCache) {
			const markdownFile = markdownFiles[filePath];
			const cacheEntry = fileCache[filePath];
			if (markdownFile && metadataCache.hasOwnProperty(cacheEntry.hash)) {
				mdCache.linkResolverQueue.add(markdownFile);
			}
		}
	};
}

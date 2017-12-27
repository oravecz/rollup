/// <reference path="./Graph.d.ts" />
import { timeStart, timeEnd } from './utils/flushTime';
import first from './utils/first';
import { keys, blank } from './utils/object';
import Module, { IdMap, ModuleJSON } from './Module';
import ExternalModule from './ExternalModule';
import ensureArray from './utils/ensureArray';
import { load, makeOnwarn, resolveId } from './utils/defaults';
import { mapSequence } from './utils/promise';
import transform from './utils/transform';
import relativeId from './utils/relativeId';
import error from './utils/error';
import { resolve, isRelative } from './utils/path';
import GlobalScope from './ast/scopes/GlobalScope';
import {
	WarningHandler, TreeshakingOptions, Plugin, ResolveIdHook, IsExternalHook, InputOptions, RollupWarning, SourceDescription
} from './rollup/index';
import NamespaceVariable from './ast/variables/NamespaceVariable';
import ExternalVariable from './ast/variables/ExternalVariable';
import { RawSourceMap } from 'source-map';
import Program from './ast/nodes/Program';
import Node from './ast/Node';
import Bundle from './Bundle';
import TemplateLiteral from './ast/nodes/TemplateLiteral';
import Literal from './ast/nodes/Literal';
import xor from 'buffer-xor';
import * as crypto from 'crypto';
import path from 'path';
import ChunkFascadeModule from './ChunkFascadeModule';

export interface Chunk {
	bundle: Bundle;
	entryPoint: Module | void;
	fileName: string,
	modules: Module[],
	exposedModules: Module[]
};

export type ResolveDynamicImportHandler = (specifier: string | Node, parentId: string) => Promise<string | void>;

export default class Graph {
	acornOptions: any;
	cachedModules: Map<string, ModuleJSON>;
	context: string;
	dynamicImport: boolean;
	externalModules: ExternalModule[];
	getModuleContext: (id: string) => string;
	hasLoaders: boolean;
	isExternal: IsExternalHook;
	isPureExternalModule: (id: string) => boolean;
	legacy: boolean;
	load: (id: string) => Promise<SourceDescription | string | void>;
	moduleById: Map<string, Module | ExternalModule>;
	modules: Module[];
	onwarn: WarningHandler;
	plugins: Plugin[];
	resolveDynamicImport: ResolveDynamicImportHandler;
	resolveId: (id: string, parent: string) => Promise<string | boolean | void>;
	scope: GlobalScope;
	treeshakingOptions: TreeshakingOptions;
	varOrConst: 'var' | 'const';

	dependsOn: { [id: string]: { [id: string]: boolean }};
	stronglyDependsOn: { [id: string]: { [id: string]: boolean } };

	// deprecated
	treeshake: boolean;

	constructor (options: InputOptions) {
		this.cachedModules = new Map();
		if (options.cache) {
			options.cache.modules.forEach(module => {
				this.cachedModules.set(module.id, module);
			});
		}
		delete options.cache; // TODO not deleting it here causes a memory leak; needs further investigation

		this.plugins = ensureArray(options.plugins);

		options = this.plugins.reduce((acc, plugin) => {
			if (plugin.options) return plugin.options(acc) || acc;
			return acc;
		}, options);

		if (!options.input) {
			throw new Error('You must supply options.input to rollup');
		}

		this.treeshake = options.treeshake !== false;
		if (this.treeshake) {
			this.treeshakingOptions = {
				propertyReadSideEffects: options.treeshake
					? (<TreeshakingOptions>options.treeshake).propertyReadSideEffects !== false
					: true,
				pureExternalModules: options.treeshake
					? (<TreeshakingOptions>options.treeshake).pureExternalModules
					: false
			};
			if (this.treeshakingOptions.pureExternalModules === true) {
				this.isPureExternalModule = () => true;
			} else if (
				typeof this.treeshakingOptions.pureExternalModules === 'function'
			) {
				this.isPureExternalModule = this.treeshakingOptions.pureExternalModules;
			} else if (Array.isArray(this.treeshakingOptions.pureExternalModules)) {
				const pureExternalModules = new Set(
					this.treeshakingOptions.pureExternalModules
				);
				this.isPureExternalModule = id => pureExternalModules.has(id);
			} else {
				this.isPureExternalModule = () => false;
			}
		} else {
			this.isPureExternalModule = () => false;
		}

		this.resolveId = first(
			[((id: string, parentId: string) => (this.isExternal(id, parentId, false) ? false : null)) as ResolveIdHook]
				.concat(this.plugins.map(plugin => plugin.resolveId).filter(Boolean))
				.concat(resolveId)
		);

		const loaders = this.plugins.map(plugin => plugin.load).filter(Boolean);
		this.hasLoaders = loaders.length !== 0;
		this.load = first(loaders.concat(load));

		this.scope = new GlobalScope();

		// TODO strictly speaking, this only applies with non-ES6, non-default-only bundles
		['module', 'exports', '_interopDefault'].forEach(name => {
			this.scope.findVariable(name); // creates global variable as side-effect
		});

		this.moduleById = new Map();
		this.modules = [];
		this.externalModules = [];

		this.context = String(options.context);

		const optionsModuleContext = options.moduleContext;
		if (typeof optionsModuleContext === 'function') {
			this.getModuleContext = id => optionsModuleContext(id) || this.context;
		} else if (typeof optionsModuleContext === 'object') {
			const moduleContext = new Map();
			Object.keys(optionsModuleContext).forEach(key => moduleContext.set(resolve(key), optionsModuleContext[key]));
			this.getModuleContext = id => moduleContext.get(id) || this.context;
		} else {
			this.getModuleContext = () => this.context;
		}

		if (typeof options.external === 'function') {
			this.isExternal = options.external;
		} else {
			const ids = ensureArray(options.external);
			this.isExternal = id => ids.indexOf(id) !== -1;
		}

		this.onwarn = options.onwarn || makeOnwarn();

		this.varOrConst = options.preferConst ? 'const' : 'var';
		this.legacy = options.legacy;
		this.acornOptions = options.acorn || {};
		this.dynamicImport = typeof options.experimentalDynamicImport === 'boolean' ? options.experimentalDynamicImport : false;

		if (this.dynamicImport) {
			this.resolveDynamicImport = first([
				...this.plugins.map(plugin => plugin.resolveDynamicImport).filter(Boolean),
				<ResolveDynamicImportHandler> ((specifier, parentId) => typeof specifier === 'string' && this.resolveId(specifier, parentId))
			]);
			this.acornOptions.plugins = this.acornOptions.plugins || {};
			this.acornOptions.plugins.dynamicImport = true;
		}
	}

	private loadModule (entryName: string) {
		return this.resolveId(entryName, undefined)
			.then(id => {
				if (id === false) {
					error({
						code: 'UNRESOLVED_ENTRY',
						message: `Entry module cannot be external`
					});
				}

				if (id == null) {
					error({
						code: 'UNRESOLVED_ENTRY',
						message: `Could not resolve entry (${entryName})`
					});
				}

				return this.fetchModule(<string>id, undefined);
			});
	}

	private link () {
		this.modules.forEach(module => module.bindImportSpecifiers());
		this.modules.forEach(module => module.bindReferences());

		this.stronglyDependsOn = blank();
		this.dependsOn = blank();

		this.modules.forEach(module => {
			this.stronglyDependsOn[module.id] = blank();
			this.dependsOn[module.id] = blank();
		});

		this.modules.forEach(module => {
			const processStrongDependency = (dependency: Module) => {
				if (
					dependency === module ||
					this.stronglyDependsOn[module.id][dependency.id]
				)
					return;

				this.stronglyDependsOn[module.id][dependency.id] = true;
				dependency.strongDependencies.forEach(processStrongDependency);
			}

			const processDependency = (dependency: Module) => {
				if (dependency === module || this.dependsOn[module.id][dependency.id])
					return;

				this.dependsOn[module.id][dependency.id] = true;
				dependency.dependencies.forEach(processDependency);
			}

			module.strongDependencies.forEach(processStrongDependency);
			module.dependencies.forEach(processDependency);
		});
	}

	buildSingle (entryModuleId: string): Promise<Bundle> {
		// Phase 1 – discovery. We load the entry module and find which
		// modules it imports, and import those, until we have all
		// of the entry module's dependencies
		timeStart('phase 1');
		return this.loadModule(entryModuleId)
			.then(entryModule => {
				timeEnd('phase 1');

				// Phase 2 - linking. We populate the module dependency links
				// including linking binding references between modules. We also
				// determine the topological execution order for the bundle
				timeStart('phase 2');

				this.link();
				const { orderedModules, dynamicImports } = this.analyseExecution([entryModule]);

				timeEnd('phase 2');

				// Phase 3 – marking. We include all statements that should be included
				timeStart('phase 3');

				// mark all export statements for the entry module and dynamic import modules
				this.mark(entryModule);
				dynamicImports.forEach(dynamicImportModule => {
					this.mark(dynamicImportModule);
					dynamicImportModule.namespace().includeVariable();
				});

				// check for unused external imports
				this.externalModules.forEach(module => {
					const unused = Object.keys(module.declarations)
						.filter(name => name !== '*')
						.filter(
						name =>
							!module.declarations[name].included &&
							!module.declarations[name].reexported
						);

					if (unused.length === 0) return;

					const names =
						unused.length === 1
							? `'${unused[0]}' is`
							: `${unused
								.slice(0, -1)
								.map(name => `'${name}'`)
								.join(', ')} and '${unused.slice(-1)}' are`;

					this.warn({
						code: 'UNUSED_EXTERNAL_IMPORT',
						source: module.id,
						names: unused,
						message: `${names} imported from external module '${
							module.id
							}' but never used`
					});
				});

				// prune unused external imports
				const externalModules = this.externalModules.filter(module => {
					return module.used || !this.isPureExternalModule(module.id);
				});

				timeEnd('phase 3');

				// Phase 4 – we ensure that names are deconflicted throughout all bundles

				timeStart('phase 4');

				const bundle = new Bundle(this, orderedModules, externalModules, entryModule);
				bundle.deconflict();

				timeEnd('phase 4');

				return bundle;
			});
	}

	buildChunks (entryModuleIds: string[]): Promise<{ [name: string]: Bundle }> {
		// Phase 1 – discovery. We load the entry module and find which
		// modules it imports, and import those, until we have all
		// of the entry module's dependencies
		timeStart('phase 1');
		return Promise.all(entryModuleIds.map(entryId => this.loadModule(entryId)))
			.then(entryModules => {
				timeEnd('phase 1');

				// Phase 2 - linking. We populate the module dependency links
				// including linking binding references between modules. We also
				// determine the topological execution order for the bundle
				// as well as computing the automated chunking graph colouring.
				timeStart('phase 2');

				this.link();
				const { orderedModules, dynamicImports } = this.analyseExecution(entryModules);

				timeEnd('phase 2');

				// Phase 3 – marking. We include all statements that should be included
				timeStart('phase 3');

				// mark all export statements for the entry module and dynamic import modules
				for (let entryModule of entryModules)
					this.mark(entryModule);
				dynamicImports.forEach(dynamicImportModule => {
					this.mark(dynamicImportModule);
				});

				// check for unused external imports
				this.externalModules.forEach(module => {
					const unused = Object.keys(module.declarations)
						.filter(name => name !== '*')
						.filter(
						name =>
							!module.declarations[name].included &&
							!module.declarations[name].reexported
						);

					if (unused.length === 0) return;

					const names =
						unused.length === 1
							? `'${unused[0]}' is`
							: `${unused
								.slice(0, -1)
								.map(name => `'${name}'`)
								.join(', ')} and '${unused.slice(-1)}' are`;

					this.warn({
						code: 'UNUSED_EXTERNAL_IMPORT',
						source: module.id,
						names: unused,
						message: `${names} imported from external module '${
							module.id
							}' but never used`
					});
				});

				timeEnd('phase 3');

				timeStart('phase 4');

				// Phase 4 - we ensure that names are deconflicted throughout all bundles
				//           then construct the bundles from the graph colouring for the chunks

				// place all modules into their unique chunks
				const chunks: { [entryPointsHash: string]: Chunk } = {};
				for (let module of orderedModules) {
					const entryPointsHashStr = module.entryPointsHash.toString('hex');
					let curChunk = chunks[entryPointsHashStr];
					if (curChunk) {
						curChunk.modules.push(module);
					}
					else {
						curChunk = chunks[entryPointsHashStr] = {
							// non entry point chunks are named chunk-<hash>
							fileName: 'chunk-' + entryPointsHashStr.substr(0, 8) + '.js',
							bundle: undefined,
							entryPoint: undefined,
							exposedModules: [],
							modules: [module]
						};
					}

					// chunk will never have more than one entry point by graph colouring
					if (module.isEntryPoint)
						curChunk.entryPoint = module;

					module.chunk = curChunk;
				}

				// run through all modules again and set exposedModules as the list
				// of modules in a chunk that aren't an entryPoint but need to be available
				// to another chunk through the fascade
				// we could probably add exact export checking here to work out the exact exposed specifiers
				for (let module of orderedModules) {
					for (let depModule of module.dependencies) {
						if (depModule.isEntryPoint)
							continue;
							if (depModule.chunk !== module.chunk) {
								if (depModule.chunk.exposedModules.indexOf(depModule) === -1)
									depModule.chunk.exposedModules.push(depModule);
							}
					}
				}

				const bundles: {
					[name: string]: Bundle
				} = {};

				const entryChunkNames: string[] = [];
				function generateUniqueEntryPointChunkName (id: string): string {
					// entry point chunks are named by the entry point itself, with deduping
					let entryName = path.basename(id);
					let ext = path.extname(entryName);
					entryName = entryName.substr(0, entryName.length - ext.length);
					if (ext !== '.js' && ext !== '.mjs')
						ext = '.js';
					let uniqueEntryName = entryName;
					let uniqueIndex = 1;
					while (entryChunkNames.indexOf(uniqueEntryName) !== -1)
						uniqueEntryName = entryName + ++uniqueIndex + ext;
					return uniqueEntryName + ext;
				}

				Object.keys(chunks).forEach(chunkName => {
					const chunk = chunks[chunkName];

					let chunkEntry = <Module | ChunkFascadeModule>chunk.entryPoint;

					// if the chunk exposes modules other than the entry point
					// then it is an actual chunk with a hidden export interface that users should never directly see
					// we export all exposed module exports through this interface, to then be used by the entry points
					if (chunk.exposedModules.length) {
						const fascadeReexports: { exportNames: string[], source: string }[] = [];
						for (let module of chunk.exposedModules) {
							// TODO: filter to exact exposed specifiers instead of all specifiers
							const exportNames = module.getExports()
								.map(exportName => module.traceExport(exportName))
								.filter(expt => expt.included)
								.map(expt => expt.getName());

							fascadeReexports.push({ exportNames, source: './' + module.id });
						}
						chunkEntry = new ChunkFascadeModule('chunk-' + chunkName, fascadeReexports);
					}
					// otherwise a direct entry point chunk (true by graph colouring)
					else {
						chunk.fileName = generateUniqueEntryPointChunkName((<Module>chunk.entryPoint).id);
					}

					// sort chunk modules by execution order
					const chunkModulesOrdered = chunk.modules.sort((moduleA, moduleB) => moduleA.execIndex > moduleB.execIndex ? 1 : -1);

					// The external modules of a chunk are firstly the referenced modules in other chunks
					// in correct execution order, followed by the external modules referenced from this chunk.
					const depsFromOtherChunks: { execIndex: number, externalModule: ExternalModule }[] = [];
					const actualExternals: ExternalModule[] = [];

					for (let module of chunkModulesOrdered) {
						// for each depModule of a module in this chunk that is not in the same chunk
						for (let depModule of module.dependencies) {
							if (chunkModulesOrdered.indexOf(depModule) !== -1)
								continue;

							// create an external module entry for the depModule and
							// trace the used imports of the external module
							// (not very efficient looping, should be a better module reference structuring here)
							const execIndex = orderedModules.indexOf(depModule);
							const externalModule = new ExternalModule('./' + depModule.chunk.fileName);
							Object.keys(module.imports).forEach(importName => {
								const impt = module.imports[importName];
								if (impt.module !== depModule)
									return;
								const exportVariable = <ExternalVariable>externalModule.traceExport(impt.name);
								exportVariable.includeVariable();
								exportVariable.setSafeName(impt.name);
							});
							depsFromOtherChunks.push({ execIndex, externalModule });
						}

						// also determine actual externals of the chunk module
						// NB we may end up importing more names than necessary here, as we import
						// names over the whole tree against this external, wheres this can be filtered
						// to just the names used by this chunk, minor though
						Object.keys(module.imports).forEach(importName => {
							const impt = module.imports[importName];
							if (impt.module.isExternal) {
								// prune unused external imports
								if (!impt.module.used && this.isPureExternalModule(impt.module.id))
									return;
								if (actualExternals.indexOf(impt.module) === -1)
									actualExternals.push(impt.module);
							}
						});
					}

					const chunkModuleExternals = depsFromOtherChunks
						.sort((a, b) => a.execIndex > b.execIndex ? 1 : -1)
						.map(item => item.externalModule).concat(actualExternals);

					const bundle = new Bundle(this, chunkModulesOrdered, chunkModuleExternals, chunkEntry);
					chunk.bundle = bundle;
					bundle.deconflict();
					bundles[chunk.fileName] = bundle;
				});

				// construct entry point fascade chunks
				// these are chunks that contain both an entry point and exposed inner modules to other chunks
				// for interface consistency, we can't expose those other exports to users so we create
				// a special fascade for the entry point that just reexports everything from the chunk
				Object.keys(chunks).forEach(chunkName => {
					const chunk = chunks[chunkName];
					if (chunk.exposedModules.length && chunk.entryPoint) {
						const fileName = generateUniqueEntryPointChunkName(chunk.entryPoint.id);
						const module = <Module>chunk.entryPoint;
						const exportNames = module.getExports()
							.map(exportName => module.traceExport(exportName))
							.filter(expt => expt.included)
							.map(expt => expt.getName());
						const entryPointFascade = new ChunkFascadeModule(fileName, [{ exportNames, source: './' + fileName }]);
						bundles[fileName] = new Bundle(this, [], [], entryPointFascade);
					}
				});

				timeEnd('phase 4');

				return bundles;
			});
	}

	private mark (entryModule: Module) {
		entryModule.getExports().forEach(name => {
			const variable = entryModule.traceExport(name);

			variable.exportName = name;
			variable.includeVariable();

			if (variable.isNamespace) {
				(<NamespaceVariable>variable).needsNamespaceBlock = true;
			}
		});

		entryModule.getReexports().forEach(name => {
			const variable = entryModule.traceExport(name);

			if (variable.isExternal) {
				variable.reexported = (<ExternalVariable>variable).module.reexported = true;
			} else {
				variable.exportName = name;
				variable.includeVariable();
			}
		});

		// mark statements that should appear in the bundle
		if (this.treeshake) {
			let addedNewNodes;
			do {
				addedNewNodes = false;
				this.modules.forEach(module => {
					if (module.includeInBundle()) {
						addedNewNodes = true;
					}
				});
			} while (addedNewNodes);
		} else {
			// Necessary to properly replace namespace imports
			this.modules.forEach(module => module.includeAllInBundle());
		}
	}

	private analyseExecution (entryModules: Module[]) {
		let hasCycles = false, curEntry: Module, curEntryHash: Buffer;
		const entrySeen: { [id: string]: boolean } = {};
		const allSeen: { [id: string]: boolean } = {};
		const ordered: Module[] = [];

		const dynamicImports: Module[] = [];

		function visit (module: Module, seen: { [id: string]: boolean } = {}) {
			if (seen[module.id]) {
				hasCycles = true;
				return;
			}
			seen[module.id] = true;

			// stop on entry points we've already top-level visited before
			// also note the
			if (module.isEntryPoint) {
				if (entrySeen[module.id])
					return;
				entrySeen[module.id] = true;
			}

			// Track entry point graph colouring by tracing all modules loaded by a given
			// entry point and colouring those modules by the hash of its id. Colours are mixed as
			// hash xors, providing the unique colouring of the graph into unique hash chunks.
			// This is really all there is to automated chunking, the rest is chunk wiring.
			if (module.entryPointsHash)
				module.entryPointsHash = xor(module.entryPointsHash, curEntryHash);
			else
				module.entryPointsHash = curEntryHash;

			module.dependencies.forEach(depModule => visit(depModule, seen));

			module.dynamicImportResolutions.forEach(module => {
				if (module instanceof Module)
					dynamicImports.push(module);
			});

			if (allSeen[module.id])
				return;
			allSeen[module.id] = true;

			module.execIndex = ordered.length;
			ordered.push(module);
		}

		for (curEntry of entryModules) {
			curEntry.isEntryPoint = true;
			curEntryHash = crypto.createHash('md5').update(curEntry.id).digest();
			visit(curEntry);
		}

		for (curEntry of dynamicImports) {
			curEntry.isEntryPoint = true;
			curEntryHash = crypto.createHash('md5').update(curEntry.id).digest();
			visit(curEntry);
		}

		if (hasCycles) {
			this.warnCycle(ordered, entryModules);
		}

		return { orderedModules: ordered, dynamicImports };
	}

	private warnCycle (ordered: Module[], entryModules: Module[]) {
		ordered.forEach((a, i) => {
			for (i += 1; i < ordered.length; i += 1) {
				const b = ordered[i];

				// TODO reinstate this! it no longer works
				if (this.stronglyDependsOn[a.id][b.id]) {
					// somewhere, there is a module that imports b before a. Because
					// b imports a, a is placed before b. We need to find the module
					// in question, so we can provide a useful error message
					let parent = '[[unknown]]';
					const visited: { [id: string]: boolean } = {};

					const findParent = (module: Module) => {
						if (this.dependsOn[module.id][a.id] && this.dependsOn[module.id][b.id]) {
							parent = module.id;
							return true;
						}
						visited[module.id] = true;
						for (let i = 0; i < module.dependencies.length; i += 1) {
							const dependency = module.dependencies[i];
							if (!visited[dependency.id] && findParent(<Module>dependency))
								return true;
						}
					};

					for (let entryModule of entryModules)
						findParent(entryModule);

					this.onwarn(
						<any>`Module ${a.id} may be unable to evaluate without ${
						b.id
						}, but is included first due to a cyclical dependency. Consider swapping the import statements in ${parent} to ensure correct ordering`
					);
				}
			}
		});
	}

	private fetchModule (id: string, importer: string): Promise<Module> {
		// short-circuit cycles
		const existingModule = this.moduleById.get(id);
		if (existingModule) {
			if (existingModule.isExternal)
				throw new Error(`Cannot fetch external module ${id}`);
			return Promise.resolve(<Module>existingModule);
		}
		this.moduleById.set(id, null);

		return this.load(id)
			.catch((err: Error) => {
				let msg = `Could not load ${id}`;
				if (importer) msg += ` (imported by ${importer})`;

				msg += `: ${err.message}`;
				throw new Error(msg);
			})
			.then(source => {
				if (typeof source === 'string') return source;
				if (source && typeof source === 'object' && source.code) return source;

				// TODO report which plugin failed
				error({
					code: 'BAD_LOADER',
					message: `Error loading ${relativeId(
						id
					)}: plugin load hook should return a string, a { code, map } object, or nothing/null`
				});
			})
			.then(source => {
				const sourceDescription: SourceDescription = typeof source === 'string' ? {
					code: source,
					ast: null
				} : source;

				if (
					this.cachedModules.has(id) &&
					this.cachedModules.get(id).originalCode === sourceDescription.code
				) {
					return this.cachedModules.get(id);
				}

				return transform(this, sourceDescription, id, this.plugins);
			})
			.then((source: {
				code: string,
				originalCode: string,
				originalSourcemap: RawSourceMap,
				ast: Program,
				sourcemapChain: RawSourceMap[],
				resolvedIds?: IdMap
			}) => {
				const {
					code,
					originalCode,
					originalSourcemap,
					ast,
					sourcemapChain,
					resolvedIds
				} = source;

				const module: Module = new Module({
					id,
					code,
					originalCode,
					originalSourcemap,
					ast,
					sourcemapChain,
					resolvedIds,
					graph: this
				});

				this.modules.push(module);
				this.moduleById.set(id, module);

				return this.fetchAllDependencies(module).then(() => {
					keys(module.exports).forEach(name => {
						if (name !== 'default') {
							module.exportsAll[name] = module.id;
						}
					});
					module.exportAllSources.forEach(source => {
						const id =
							module.resolvedIds[source] || module.resolvedExternalIds[source];
						const exportAllModule = this.moduleById.get(id);
						if (exportAllModule.isExternal) return;

						keys((<Module>exportAllModule).exportsAll).forEach(name => {
							if (name in module.exportsAll) {
								this.warn({
									code: 'NAMESPACE_CONFLICT',
									reexporter: module.id,
									name,
									sources: [
										module.exportsAll[name],
										(<Module>exportAllModule).exportsAll[name]
									],
									message: `Conflicting namespaces: ${relativeId(
										module.id
									)} re-exports '${name}' from both ${relativeId(
										module.exportsAll[name]
									)} and ${relativeId(
										(<Module>exportAllModule).exportsAll[name]
									)} (will be ignored)`
								});
							} else {
								module.exportsAll[name] = (<Module>exportAllModule).exportsAll[name];
							}
						});
					});
					return module;
				});
			});
	}

	private fetchAllDependencies (module: Module) {
		// resolve and fetch dynamic imports where possible
		const fetchDynamicImportsPromise = Promise.all(module.dynamicImports.map((node, index) => {
			const importArgument = node.parent.arguments[0];
			let dynamicImportSpecifier: string | Node;
			if (importArgument.type === 'TemplateLiteral') {
				if ((<TemplateLiteral>importArgument).expressions.length === 0 && (<TemplateLiteral>importArgument).quasis.length === 1) {
					dynamicImportSpecifier = (<TemplateLiteral>importArgument).quasis[0].value.cooked;
				}
			} else if (importArgument.type === 'Literal') {
				if (typeof (<Literal>importArgument).value === 'string') {
					dynamicImportSpecifier = (<Literal<string>>importArgument).value;
				}
			} else {
				dynamicImportSpecifier = importArgument;
			}

			return Promise.resolve(this.resolveDynamicImport(dynamicImportSpecifier, module.id))
			.then(replacement => {
				if (!replacement) {
					module.dynamicImportResolutions[index] = null;
					return;
				}

				if (typeof dynamicImportSpecifier !== 'string') {
					module.dynamicImportResolutions[index] = replacement;
					return;
				}

				// add dynamic import to the graph
				if (this.isExternal(replacement, module.id, true)) {
					if (!this.moduleById.has(replacement)) {
						const module = new ExternalModule(replacement);
						this.externalModules.push(module);
						this.moduleById.set(replacement, module);
					}

					const externalModule = <ExternalModule>this.moduleById.get(replacement);
					module.dynamicImportResolutions[index] = externalModule;
					externalModule.exportsNamespace = true;
					return;
				}

				return this.fetchModule(replacement, module.id)
				.then(depModule => {
					module.dynamicImportResolutions[index] = depModule;
					return;
				});
			});
		}));
		fetchDynamicImportsPromise.catch(() => {});

		return mapSequence(module.sources, source => {
			const resolvedId = module.resolvedIds[source];
			return (resolvedId
				? Promise.resolve(resolvedId)
				: this.resolveId(source, module.id)
			).then((resolvedId: string) => {
				const externalId =
					resolvedId ||
					(isRelative(source) ? resolve(module.id, '..', source) : source);
				let isExternal = this.isExternal(externalId, module.id, true);

				if (!resolvedId && !isExternal) {
					if (isRelative(source)) {
						error({
							code: 'UNRESOLVED_IMPORT',
							message: `Could not resolve '${source}' from ${relativeId(
								module.id
							)}`
						});
					}

					this.warn({
						code: 'UNRESOLVED_IMPORT',
						source,
						importer: relativeId(module.id),
						message: `'${source}' is imported by ${relativeId(
							module.id
						)}, but could not be resolved – treating it as an external dependency`,
						url:
							'https://github.com/rollup/rollup/wiki/Troubleshooting#treating-module-as-external-dependency'
					});
					isExternal = true;
				}

				if (isExternal) {
					module.resolvedExternalIds[source] = externalId;

					if (!this.moduleById.has(externalId)) {
						const module = new ExternalModule(externalId);
						this.externalModules.push(module);
						this.moduleById.set(externalId, module);
					}

					const externalModule = this.moduleById.get(externalId);

					// add external declarations so we can detect which are never used
					Object.keys(module.imports).forEach(name => {
						const importDeclaration = module.imports[name];
						if (importDeclaration.source !== source) return;

						externalModule.traceExport(importDeclaration.name);
					});
				} else {
					module.resolvedIds[source] = <string>resolvedId;
					return this.fetchModule(<string>resolvedId, module.id);
				}
			});
		})
		.then(() => {
			return fetchDynamicImportsPromise;
		});
	}

	warn (warning: RollupWarning) {
		warning.toString = () => {
			let str = '';

			if (warning.plugin) str += `(${warning.plugin} plugin) `;
			if (warning.loc)
				str += `${relativeId(warning.loc.file)} (${warning.loc.line}:${
					warning.loc.column
					}) `;
			str += warning.message;

			return str;
		};

		this.onwarn(warning);
	}
}

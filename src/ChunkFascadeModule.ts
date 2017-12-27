import ExternalVariable from './ast/variables/ExternalVariable';
import Variable from './ast/variables/Variable';

/*
 * This module is only for Bundle and finalizers and allows
 * us to construct fascades for two scenarios required in code
 * splitting:
 * 1. Creating the fascade of a chunk with no entry points,
 *    that exports all bindings used by other chunks
 * 2. Creating the fascade for an entry point, when that
 *    entry point and a dependency of the entry point are
 *    in the same chunk and shared such that the entry point
 *    cannot be the chunk otherwise it would have an invalid
 *    interface (additional external export names that wouldn't
 *    actually be public).
 *    In this case we construct the entry point simply as a
 *    re-exporter of the restricted entry point export names
 *    from the chunk.
 *
 * To handle both cases, the constructor takes a list
 * of reexports.
 *
 * Note also that this module doesn't affect execution order
 * despite having imports in it. It doesn't fit into the model
 * of a module in the input graph, but as a "module descriptor"
 * for the output graph.
 */
export default class ChunkFascadeModule {
	declarations: {[name: string]: ExternalVariable};
	source: string;
	id: string;

	// not strictly sure which of these are necessary...
	isExternal: false;
	reexported: boolean;
	used: boolean;
	exportsNames: boolean;
	exportsNamespace: boolean;

	reexports: string[];
	exports: { [name: string]: any };

	exportNames: string[]

	exportAllSources: string[];

	// TODO: export * (exportAllSources) handling
	constructor (id: string, reexports: { exportNames: string[], source: string }[]) {
		this.id = id;
		this.source = '';
		this.exportNames = [];
		for (let { exportNames, source } of reexports) {
			exportNames.forEach(expt => this.exportNames.push(expt));
			this.source += `export { ${exportNames.join(', ')} } from '${source}';\n`;
		}

		this.isExternal = false;
		this.used = true;

		this.exports = {};

		// we dont track these reexports as actual reexports, because we need this fascade to be
		// opaque in analysis - finaliser traces shouldn't go through it.
		this.reexports = [];
		this.exportsNames = true;
		this.exportAllSources = [];
		this.declarations = {};
	}

	getExports () {
		return this.exportNames;
	}

	getReexports (): string[] {
		return this.reexports;
	}

	traceExport (name: string): Variable {
		let expt = this.declarations[name];
		if (!expt) {
			expt = new ExternalVariable(this, name);
			expt.setSafeName(name);
			this.declarations[name] = expt;
		}
		return expt;
	}
}

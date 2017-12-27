import Variable from './Variable';
import Identifier from '../nodes/Identifier';
import ExternalModule from '../../ExternalModule';
import ChunkFascadeModule from '../../ChunkFascadeModule';

export default class ExternalVariable extends Variable {
	module: ExternalModule | ChunkFascadeModule;
	safeName: string;
	isExternal: true;
	isNamespace: boolean;

	constructor (module: ExternalModule | ChunkFascadeModule, name: string) {
		super(name);
		this.module = module;
		this.safeName = null;
		this.isExternal = true;
		this.isNamespace = name === '*';
	}

	addReference (identifier: Identifier) {
		if (this.name === 'default' || this.name === '*') {
			(<ExternalModule>this.module).suggestName(identifier.name);
		}
	}

	getName (es: boolean) {
		const module = <ExternalModule>this.module;

		if (this.name === '*') {
			return module.name;
		}

		if (this.name === 'default') {
			return module.exportsNamespace || (!es && module.exportsNames)
				? `${module.name}__default`
				: module.name;
		}

		return es ? this.safeName : `${module.name}.${this.name}`;
	}

	includeVariable () {
		if (this.included) {
			return false;
		}
		this.included = true;
		this.module.used = true;
		return true;
	}

	setSafeName (name: string) {
		this.safeName = name;
	}
}

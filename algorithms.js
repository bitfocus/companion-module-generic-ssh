
const Ciphers = {
	AUTO: 0,
	AES256: 1,
	AES192: 2,
	AES128: 3,
}

function createAlgorithmsObjectForSSH2(config) {
	let regex = undefined;

	switch (config.preferedCipher) {
		case Ciphers.AUTO:
			return undefined;
		case Ciphers.AES256:
			regex = new RegExp(/aes256/, 'gi');
			break;
		case Ciphers.AES192:
			regex = new RegExp(/aes192/, 'gi');
			break;
		case Ciphers.AES128:
			regex = new RegExp(/aes128/, 'gi');
			break;
		default:
			regex = null;
			break;
	}

	return {
		cipher: {
			prepend: regex
		}
	}
}

module.exports = {
	Ciphers,
	createAlgorithmsObjectForSSH2
}
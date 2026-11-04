const assert = require('node:assert/strict')
const { test } = require('node:test')
const { readFileSync, mkdtempSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { createRequire } = require('node:module')
const vm = require('node:vm')
const { generateKeyPairSync } = require('node:crypto')
const { Server, utils } = require('ssh2')
const base = require('@companion-module/base')

// Capture the real entrypoint without starting Companion IPC. Only host methods
// are substituted; SSH, actions, feedbacks and lifecycle run the module's code.
function loadInstance() {
	let Instance
	class Host {
		constructor() {
			this.values = {}
			this.statuses = []
			this.logs = []
		}
		setActionDefinitions(actions) {
			this.actions = actions
		}
		setFeedbackDefinitions(feedbacks) {
			this.feedbacks = feedbacks
		}
		setVariableDefinitions(definitions) {
			this.definitions = definitions
		}
		setVariableValues(values) {
			Object.assign(this.values, values)
		}
		getVariableValue(id) {
			return this.values[id]
		}
		checkFeedbacks(id) {
			this.checked = id
		}
		updateStatus(status) {
			this.statuses.push(status)
		}
		log(level, message) {
			this.logs.push([level, message])
		}
		async parseVariablesInString(text) {
			throw new Error('Commands must not be parsed twice')
		}
	}
	const filename = resolve(__dirname, '../main.js')
	const localRequire = createRequire(filename)
	vm.runInNewContext(
		readFileSync(filename, 'utf8'),
		{
			require: (id) =>
				id === '@companion-module/base'
					? {
							...base,
							InstanceBase: Host,
							runEntrypoint: (value) => {
								Instance = value
							},
						}
					: localRequire(id),
			setTimeout,
			clearTimeout,
		},
		{ filename },
	)
	return new Instance()
}

async function until(predicate) {
	const deadline = Date.now() + 8000
	while (!predicate()) {
		assert.ok(Date.now() < deadline, 'Timed out waiting for SSH behavior')
		await new Promise((resolve) => setTimeout(resolve, 20))
	}
}

const key = generateKeyPairSync('rsa', { modulusLength: 2048 })
const hostKey = key.privateKey.export({ type: 'pkcs1', format: 'pem' })

for (const authentication of ['password', 'private key', 'encrypted private key']) {
	test(
		`real SSH ${authentication}: exec, shell, feedback, reconfigure, reconnect and destroy`,
		{ timeout: 30000 },
		async (t) => {
			const directory = mkdtempSync(join(tmpdir(), 'generic-ssh-'))
			const keyPath = join(directory, 'key.pem')
			const passphrase = authentication === 'encrypted private key' ? 'test-passphrase' : undefined
			writeFileSync(
				keyPath,
				key.privateKey.export({
					type: 'pkcs1',
					format: 'pem',
					...(passphrase ? { cipher: 'aes-256-cbc', passphrase } : {}),
				}),
				{ mode: 0o600 },
			)
			const publicKey = utils.parseKey(hostKey)
			const commands = []
			const shells = []
			const clients = new Set()
			let connections = 0
			const server = new Server({ hostKeys: [hostKey] }, (client) => {
				clients.add(client)
				client.on('error', () => {})
				client.on('close', () => clients.delete(client))
				client.on('authentication', (context) => {
					if (context.username !== 'tester') return context.reject()
					if (authentication === 'password') {
						return context.method === 'password' && context.password === 'test-password'
							? context.accept()
							: context.reject()
					}
					if (
						context.method === 'publickey' &&
						context.key.data.equals(publicKey.getPublicSSH()) &&
						(!context.signature || publicKey.verify(context.blob, context.signature, context.hashAlgo))
					) {
						context.accept()
					} else context.reject()
				})
				client.on('ready', () => {
					connections++
					client.on('session', (accept) => {
						const session = accept()
						session.on('pty', (accept) => accept())
						session.on('exec', (accept, reject, info) => {
							commands.push(info.command)
							const stream = accept()
							if (info.command === 'stderr') stream.stderr.write('controlled error')
							stream.write('controlled output')
							stream.exit(info.command === 'fail' ? 7 : 0)
							stream.end()
						})
						session.on('shell', (accept) => {
							const stream = accept()
							let text = ''
							stream.on('data', (data) => {
								text += data
							})
							stream.on('end', () => {
								shells.push(text)
								stream.exit(0)
								stream.end('shell output')
							})
						})
					})
				})
			})
			const instance = loadInstance()
			t.after(async () => {
				await instance.destroy()
				for (const client of clients) client.destroy()
				await new Promise((resolve) => server.close(resolve))
				rmSync(directory, { recursive: true, force: true })
			})
			await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
			const config = {
				host: '127.0.0.1',
				port: server.address().port,
				username: 'tester',
				password: authentication === 'password' ? 'test-password' : '',
				privatekeypath: keyPath,
				passphrase,
				keepaliveInterval: 0,
				handshakeCompleteTimeout: 5000,
				preferedCipher: 0,
			}
			await instance.init(config)
			await until(() => connections === 1 && instance.statuses.at(-1) === base.InstanceStatus.Ok)
			assert.equal(instance.getConfigFields().find((field) => field.id === 'port').default, 22)
			assert.equal(instance.definitions[0].variableId, 'returnedError')
			await instance.actions.execCommand.callback({ options: { cmd: 'echo hello\\nprintf \\\\n' } })
			await until(() => commands.length === 2)
			assert.deepEqual(commands, ['echo hello', 'printf \\n'])
			await until(() => instance.logs.some(([, message]) => message === 'controlled output'))
			assert.equal(instance.values.returnedError, false)
			await instance.actions.execCommand.callback({ options: { cmd: 'stderr' } })
			await until(() => instance.values.returnedError === true)
			assert.equal(instance.feedbacks.commandErrorState.callback({}), true)
			assert.equal(instance.checked, 'commandErrorState')
			await instance.actions.execCommand.callback({ options: { cmd: 'fail' } })
			await until(() => instance.logs.some(([, message]) => message.includes('error code: 7')))
			assert.equal(instance.values.returnedError, true)
			await instance.actions.shellCommand.callback({ options: { cmd: 'echo hello\\nprintf \\\\n' } })
			await until(() => shells.length === 1)
			assert.equal(shells[0], 'echo hello\nprintf \\n\nexit\n')
			await until(() => instance.logs.some(([, message]) => message === 'shell output'))
			await instance.configUpdated(config)
			await until(() => connections === 2 && instance.statuses.at(-1) === base.InstanceStatus.Ok)
			for (const client of clients) client.end()
			await until(() => connections >= 3 && instance.statuses.at(-1) === base.InstanceStatus.Ok)
			await instance.destroy()
			assert.equal(instance.reconnectTimer, undefined)
			assert.equal(instance.sshClient, undefined)
			const count = connections
			await new Promise((resolve) => setTimeout(resolve, 1200))
			assert.equal(connections, count, 'destroy must stop reconnecting')
		},
	)
}

// Values returned by the host may themselves contain variable-looking text.
// Evaluating them again changes the command compared with the published SDK.
test('already resolved commands retain literal variable-looking output', async () => {
	const instance = loadInstance()
	instance.updateActions()
	instance.getConstants = () => ({ CMD_ERROR_VAR_NAME: 'returnedError', CMD_ERROR_FEEDBACK_NAME: 'commandErrorState' })
	const sent = []
	instance.sshClient = { exec: (command) => sent.push(command) }
	assert.equal(instance.actions.execCommand.options[0].useVariables, true)
	assert.equal(instance.actions.shellCommand.options[0].useVariables, true)
	await instance.actions.execCommand.callback({ options: { cmd: 'echo $(literal:value)' } })
	assert.deepEqual(sent, ['echo $(literal:value)'])
})

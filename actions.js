module.exports = function (self) {
	self.setActionDefinitions({
		execCommand: {
			name: 'Execute SSH Command',
			options: [
				{
					id: 'cmd',
					type: 'textinput',
					label: 'Command',
					tooltip:
						'Executes command(s) on the remove server. You can execute multiple commands asynchronously if you separate them with \\n.\nSee help page for more info.',
					useVariables: true,
				},
			],
			callback: async (event) => {
				// make sure that we start our execution status as OK
				self.setVariableValues({ [self.getConstants().CMD_ERROR_VAR_NAME]: false })
				self.checkFeedbacks(self.getConstants().CMD_ERROR_FEEDBACK_NAME)

				let cmd = event.options.cmd
				//parse the command for any variables
				let cmdParsed = await self.parseVariablesInString(cmd)

				// we need to check for line breaks and execute each line as a separate command
				// NOTE: if you need \n to be in the string without a linefeed, you can use \\n to escape \n representing linefeed
				let currentCmds = cmdParsed.split(/\\*(?<!\\)\\n/g)

				currentCmds.forEach((element) => {
					// make sure to replace any \\n with a regular \n
					let currentCmd = element.replace(/\\\\n/g, '\\n')

					self.log('debug', 'Executing command: ' + currentCmd)

					self.sshClient.exec(currentCmd, (err, stream) => {
						stream.stderr.on('data', (data) => {
							// here is where a STDERR happened
							self.setVariableValues({ [self.getConstants().CMD_ERROR_VAR_NAME]: true })
							self.checkFeedbacks(self.getConstants().CMD_ERROR_FEEDBACK_NAME)
							self.log('error', 'Command: ' + currentCmd + ' wrote to STDERR: ')
						})

						stream.on('exit', (code) => {
							if (code != 0) {
								// we have an error code that is not 0 coming back, show error status
								self.setVariableValues({ [self.getConstants().CMD_ERROR_VAR_NAME]: true })
								self.checkFeedbacks(self.getConstants().CMD_ERROR_FEEDBACK_NAME)
								self.log('error', 'Command: ' + currentCmd + ' exited with error code: ' + code)
							}
						})

						stream.on('data', (data) => {
							self.setVariableValues({ [self.getConstants().CMD_RETURN_VAR_NAME]: data.toString() })
							self.log('debug', data.toString())
						})
					})
				})
			},
		},
		shellCommand: {
			name: 'Execute SSH Command in Shell Session (Advanced)',
			options: [
				{
					id: 'cmd',
					type: 'textinput',
					label: 'Command',
					tooltip:
						'Execute command(s) on the remote server using a shell session. You can execute multiple commands sequentially if you separate them with \\n.\nSee help page for more info.',
					useVariables: true,
				},
			],
			callback: async (event) => {
				// make sure that we start our execution status as OK
				self.setVariableValues({ [self.getConstants().CMD_ERROR_VAR_NAME]: false })
				self.checkFeedbacks(self.getConstants().CMD_ERROR_FEEDBACK_NAME)

				let cmd = event.options.cmd
				//parse the command for any variables
				let cmdParsed = await self.parseVariablesInString(cmd)

				self.log('debug', 'Executing advanced command: ' + cmdParsed);

				self.sshClient.shell((err, stream) => {
					stream
						.on('close', (code) => {
							self.log('debug', 'stream closed with code: ' + code)
							if (code != 0) {
								self.setVariableValues({ [self.getConstants().CMD_ERROR_VAR_NAME]: true })
								self.checkFeedbacks(self.getConstants().CMD_ERROR_FEEDBACK_NAME)
							}
						})
						.on('data', (data) => {
							self.log('debug', data.toString())
						})
						.on('error', (e) => {
							self.log('error', 'Stream error: ' + e)
							self.setVariableValues({ [self.getConstants().CMD_ERROR_VAR_NAME]: true })
							self.checkFeedbacks(self.getConstants().CMD_ERROR_FEEDBACK_NAME)
							self.sshClient.end()
						})

					// we need to check for line breaks and execute each line as a separate command
					// NOTE: if you need \n to be in the string without a linefeed, you can use \\n to escape \n representing linefeed
					let currentCmd = cmdParsed.replace(/\\*(?<!\\)\\n/g, String.fromCharCode(10))

					// make sure to replace any \\n with a regular \n
					currentCmd = currentCmd.replace(/\\\\n/g, '\\n')

					// make sure to concat a \nexit\n at the end, so that we can end the shell session when we are done executing commands
					currentCmd = currentCmd + String.fromCharCode(10) + 'exit' + String.fromCharCode(10)

					self.log('debug', 'Executing command: ' + currentCmd)
					stream.end(currentCmd)
				})
			},
		},
	})
}

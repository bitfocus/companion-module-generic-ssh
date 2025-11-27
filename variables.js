module.exports = async function (self) {
	self.setVariableDefinitions([
		{
			variableId: self.getConstants().CMD_ERROR_VAR_NAME,
			name: 'Command Error'
		}, {
			variableId: self.getConstants().CMD_RETURN_VAR_NAME,
			name: 'Command Return Value'
	}])
	self.setVariableValues({ [self.getConstants().CMD_ERROR_VAR_NAME]: false })
}

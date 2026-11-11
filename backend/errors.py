class WorkspaceError(Exception):
    def __init__(self, code, message, status=400, **details):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.details = details

    def payload(self):
        return {"error": {"code": self.code, "message": self.message, "status": self.status, **self.details}}


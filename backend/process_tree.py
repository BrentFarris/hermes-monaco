"""Owned process groups on POSIX and kill-on-close Job Objects on Windows."""
import os
import signal
import subprocess
import threading
import time


class ProcessTree:
    def __init__(self):
        self.job = None
        self.process = None
        self.lock = threading.RLock()
        if os.name == "nt":
            self._create_job()

    def _create_job(self):
        import ctypes
        from ctypes import wintypes

        class BasicLimit(ctypes.Structure):
            _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                        ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                        ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                        ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD)]

        class IoCounters(ctypes.Structure):
            _fields_ = [(name, ctypes.c_uint64) for name in (
                "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

        class ExtendedLimit(ctypes.Structure):
            _fields_ = [("BasicLimitInformation", BasicLimit), ("IoInfo", IoCounters),
                        ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                        ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]

        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        kernel.CreateJobObjectW.restype = wintypes.HANDLE
        kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        kernel.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        job = kernel.CreateJobObjectW(None, None)
        if not job:
            raise ctypes.WinError(ctypes.get_last_error())
        limits = ExtendedLimit()
        limits.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not kernel.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            error = ctypes.WinError(ctypes.get_last_error())
            kernel.CloseHandle(job)
            raise error
        self.kernel, self.job = kernel, job

    def spawn(self, argv, cwd, env):
        options = {"creationflags": subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == "nt" else {"start_new_session": True}
        try:
            self.process = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, **options)
            if self.job:
                import ctypes
                if not self.kernel.AssignProcessToJobObject(self.job, int(self.process._handle)):
                    raise ctypes.WinError(ctypes.get_last_error())
            return self.process
        except BaseException:
            if self.process and self.process.poll() is None:
                self.process.kill()
                self.process.wait()
            self.close()
            raise

    def stop(self, grace=2.0):
        if os.name == "nt":
            with self.lock:
                if self.job:
                    self.kernel.TerminateJobObject(self.job, 1)
            return
        if self.process:
            pid = self.process.pid
            try:
                os.killpg(pid, signal.SIGTERM)
            except ProcessLookupError:
                return
            deadline = time.monotonic() + grace
            while time.monotonic() < deadline:
                try:
                    os.killpg(pid, 0)
                except ProcessLookupError:
                    return
                time.sleep(0.025)
            try:
                os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    def close(self):
        with self.lock:
            if self.job:
                self.kernel.CloseHandle(self.job)
                self.job = None


"""What one Tekton import is doing, for the person watching: a step list, the fact check, and its time and cost.

An import runs in a background thread and its readers run on worker threads. The current run travels in a
context variable (builder._parallel copies the context into each worker), so any reader can add a step or a count
without a parameter on every function. With no run (tests, the blank draft) every call here does nothing.

Cost is tokens times the model's price. Prices come from Gloo's public model list (read once, cached), with a
small table of the builder's usual models as the fallback when the list cannot be read.
"""
import contextvars
import json
import logging
import threading
import time
import urllib.request

log = logging.getLogger(__name__)

MAX_STEPS = 120
MAX_LOG = 80
_current = contextvars.ContextVar('tekton_run', default=None)

# USD per million tokens (input, output), from https://platform.ai.gloo.com/platform/v2/models on 2026-10-07.
PRICES = {
    'gloo-anthropic-claude-haiku-4.5': (1.00, 5.00),
    'gloo-qwen-3.7-flash': (0.03, 0.13),
    'gloo-qwen-3.7-plus': (0.32, 1.28),
}
MODELS_URL = 'https://platform.ai.gloo.com/platform/v2/models'
_prices, _prices_lock = None, threading.Lock()


def _price_list():
    """{model id: (input, output) per million tokens}: Gloo's list, read once, else the table above."""
    global _prices
    with _prices_lock:
        if _prices is None:
            _prices = dict(PRICES)
            try:
                with urllib.request.urlopen(MODELS_URL, timeout=4) as response:
                    for model in json.load(response):
                        pricing = model.get('pricing') or {}
                        rate = lambda kind: float(pricing[kind]['rate_per_1m_tokens'])  # noqa: E731
                        try:
                            _prices[model['id']] = (rate('input'), rate('output'))
                        except (KeyError, TypeError, ValueError):
                            continue
            except Exception as error:  # offline, or the list moved: the table still prices the usual models
                log.info('builder: Gloo model prices not read (%s); using the built-in table', error)
        return _prices


def price(model):
    """(input, output) USD per million tokens, (0, 0) for a model on our own hardware, None when unknown."""
    if not model:
        return None
    if not model.startswith('gloo-'):
        return (0.0, 0.0)  # Ollama on the laptop or the team's GPU: no per-token bill
    return _price_list().get(model)


class Run:
    def __init__(self):
        self.lock = threading.Lock()
        self.started = time.monotonic()
        self.steps = []
        self.dropped = {}
        self.calls, self.failed = 0, 0
        self.tokens = {}  # model -> [input, output]
        self.modes = {}  # how answers came back: 'json_schema', 'tools', 'json_schema_fallback' -> calls
        self.log = []  # one entry per AI call: mode, endpoint, model, seconds, tokens (the newest MAX_LOG)
        self.version = 0  # bumped on every change, so a saver knows when to write

    def _changed(self):
        self.version += 1

    def step(self, text, kind='step'):
        with self.lock:
            self.steps.append({'at': round(time.monotonic() - self.started, 1), 'text': str(text)[:240], 'kind': kind})
            if len(self.steps) > MAX_STEPS:
                del self.steps[1]  # keep the first step and the newest ones
            self._changed()

    def drop(self, reason, count=1):
        if count <= 0:
            return
        with self.lock:
            self.dropped[reason] = self.dropped.get(reason, 0) + count
            self._changed()

    def ai(self, model, usage=None, failed=False, mode=None, endpoint='', seconds=None):
        with self.lock:
            self.calls += 1
            self.failed += bool(failed)
            if mode:
                self.modes[mode] = self.modes.get(mode, 0) + 1
                self.log.append({'mode': mode, 'endpoint': endpoint, 'model': model or '', 'failed': bool(failed),
                                 'seconds': round(seconds, 2) if seconds is not None else None,
                                 'tokens_in': int(getattr(usage, 'prompt_tokens', 0) or 0),
                                 'tokens_out': int(getattr(usage, 'completion_tokens', 0) or 0)})
                del self.log[:-MAX_LOG]
            if usage is not None:
                counts = self.tokens.setdefault(model or '', [0, 0])
                counts[0] += int(getattr(usage, 'prompt_tokens', 0) or 0)
                counts[1] += int(getattr(usage, 'completion_tokens', 0) or 0)
            self._changed()

    def seconds(self):
        return round(time.monotonic() - self.started, 1)

    def cost(self):
        """USD for the tokens used, or None when a model's price is unknown."""
        total = 0.0
        for model, (tokens_in, tokens_out) in self.tokens.items():
            rates = price(model)
            if rates is None:
                return None
            total += tokens_in / 1e6 * rates[0] + tokens_out / 1e6 * rates[1]
        return round(total, 4)

    def snapshot(self):
        """The progress the page shows while the import runs."""
        with self.lock:
            return {'steps': list(self.steps), 'checked': sum(self.dropped.values()), 'seconds': self.seconds()}

    def summary(self, pages=0, sources=0):
        """Saved on the finished draft: the steps, the fact check, and the time and cost of the run."""
        with self.lock:
            steps, dropped = list(self.steps), dict(self.dropped)
            tokens_in = sum(t[0] for t in self.tokens.values())
            tokens_out = sum(t[1] for t in self.tokens.values())
            models = sorted(m for m in self.tokens if m)
            calls, failed, modes, log_ = self.calls, self.failed, dict(self.modes), list(self.log)
        return {'steps': steps, 'seconds': self.seconds(), 'pages': pages, 'sources': sources,
                'dropped': dropped, 'dropped_total': sum(dropped.values()), 'ai_calls': calls, 'ai_failed': failed,
                'tokens_in': tokens_in, 'tokens_out': tokens_out, 'models': models, 'cost_usd': self.cost(),
                'output_modes': modes, 'ai_log': log_}


def start():
    """A new run for this thread (and the workers it starts). Returns (run, token for finish)."""
    run = Run()
    return run, _current.set(run)


def finish(token):
    _current.reset(token)


def current():
    return _current.get()


def step(text, kind='step'):
    run = _current.get()
    if run is not None:
        run.step(text, kind)


def drop(reason, count=1):
    run = _current.get()
    if run is not None:
        run.drop(reason, count)


def ai(model, usage=None, failed=False, mode=None, endpoint='', seconds=None):
    run = _current.get()
    if run is not None:
        run.ai(model, usage, failed, mode, endpoint, seconds)


def money(usd):
    """'$0.04', 'under $0.01', or '' when unknown."""
    if usd is None:
        return ''
    if usd == 0:
        return 'no AI cost'
    return 'under $0.01' if usd < 0.01 else f'${usd:.2f}'

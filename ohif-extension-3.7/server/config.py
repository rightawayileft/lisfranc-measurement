import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from urllib.parse import urlsplit


def setting(name: str) -> str:
    value = os.environ.get(name)
    file = os.environ.get(f"{name}_FILE")
    if bool(value) == bool(file):
        raise ValueError(f"Configure exactly one of {name} or {name}_FILE.")
    result = Path(file).read_text(encoding="utf-8").strip() if file else value
    if not result:
        raise ValueError(f"{name} is empty.")
    return result


@dataclass(frozen=True)
class Settings:
    database_url: str
    origin: str
    proxy_token: bytes


@lru_cache(maxsize=1)
def settings() -> Settings:
    database_url = setting("LISFRANC_DATABASE_URL")
    origin = setting("LISFRANC_APP_ORIGIN")
    parsed = urlsplit(origin)
    if (parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username
            or parsed.password or parsed.path or parsed.query or parsed.fragment
            or origin != f"{parsed.scheme}://{parsed.netloc}"
            or (parsed.scheme == "http" and parsed.hostname not in ("127.0.0.1", "localhost", "::1"))):
        raise ValueError("LISFRANC_APP_ORIGIN must be an HTTPS origin (HTTP allowed only for loopback tests).")
    proxy_token = setting("LISFRANC_PROXY_TOKEN").encode("ascii")
    if len(proxy_token) < 32 or not all(33 <= byte <= 126 for byte in proxy_token):
        raise ValueError("LISFRANC_PROXY_TOKEN must contain at least 32 visible ASCII characters.")
    return Settings(database_url=database_url, origin=origin, proxy_token=proxy_token)

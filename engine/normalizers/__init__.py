from . import generic_vse

# Maps "normalizer" in config/source.json to a module exposing
# canonicalize(raw, tariff) and normalize(doc, org, tariff, date, retrieved_at, check).
REGISTRY = {
    "generic_vse": generic_vse,
}

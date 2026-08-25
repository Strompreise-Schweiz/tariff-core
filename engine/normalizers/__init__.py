from . import generic_vse

# Maps the "normalizer" key from a calling repo's config/source.json to a
# module exposing local_date_of(raw), to_vse(raw), normalize(raw, org, retrieved_at, date).
REGISTRY = {
    "generic_vse": generic_vse,
}

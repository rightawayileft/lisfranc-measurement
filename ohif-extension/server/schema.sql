BEGIN;

CREATE SCHEMA IF NOT EXISTS lisfranc_clinical;

CREATE TABLE IF NOT EXISTS lisfranc_clinical.studies (
    study_uid varchar(64) PRIMARY KEY,
    enrolled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (study_uid ~ '^[0-9]+(\.[0-9]+)*$')
);

ALTER TABLE lisfranc_clinical.studies ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS lisfranc_clinical.study_claims (
    study_uid varchar(64) PRIMARY KEY REFERENCES lisfranc_clinical.studies(study_uid),
    holder varchar(128) NOT NULL,
    lease_id uuid NOT NULL,
    expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS lisfranc_clinical.reviews (
    study_uid varchar(64) NOT NULL REFERENCES lisfranc_clinical.studies(study_uid),
    series_uid varchar(64) NOT NULL,
    sop_uid varchar(64) NOT NULL,
    frame_number integer NOT NULL CHECK (frame_number > 0),
    revision bigint NOT NULL CHECK (revision > 0 AND revision <= 9007199254740991),
    status text NOT NULL CHECK (status IN ('draft', 'approved', 'skipped', 'rejected')),
    record jsonb NOT NULL,
    updated_by varchar(128) NOT NULL,
    updated_at timestamptz NOT NULL,
    PRIMARY KEY (study_uid, series_uid, sop_uid, frame_number),
    CHECK (series_uid ~ '^[0-9]+(\.[0-9]+)*$'),
    CHECK (sop_uid ~ '^[0-9]+(\.[0-9]+)*$')
);

CREATE TABLE IF NOT EXISTS lisfranc_clinical.review_events (
    study_uid varchar(64) NOT NULL,
    series_uid varchar(64) NOT NULL,
    sop_uid varchar(64) NOT NULL,
    frame_number integer NOT NULL,
    revision bigint NOT NULL,
    status text NOT NULL CHECK (status IN ('draft', 'approved', 'skipped', 'rejected')),
    record jsonb NOT NULL,
    updated_by varchar(128) NOT NULL,
    updated_at timestamptz NOT NULL,
    PRIMARY KEY (study_uid, series_uid, sop_uid, frame_number, revision),
    FOREIGN KEY (study_uid, series_uid, sop_uid, frame_number)
        REFERENCES lisfranc_clinical.reviews(study_uid, series_uid, sop_uid, frame_number)
);

COMMIT;

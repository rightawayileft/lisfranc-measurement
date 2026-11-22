-- Run once as the owner of lisfranc_clinical, after creating lisfranc_app.
GRANT CONNECT ON DATABASE lisfranc TO lisfranc_app;
GRANT USAGE ON SCHEMA lisfranc_clinical TO lisfranc_app;
GRANT SELECT ON lisfranc_clinical.studies TO lisfranc_app;
GRANT SELECT, INSERT, UPDATE ON lisfranc_clinical.reviews TO lisfranc_app;
GRANT SELECT, INSERT ON lisfranc_clinical.review_events TO lisfranc_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON lisfranc_clinical.study_claims TO lisfranc_app;

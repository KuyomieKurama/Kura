ALTER TABLE immich_transfers
  ADD COLUMN verified_byte_size bigint,
  ADD COLUMN verified_album_state text CHECK (verified_album_state IN ('none', 'assigned')),
  ADD COLUMN verified_album_id text,
  ADD CONSTRAINT immich_transfers_verified_evidence_check CHECK (
    (status <> 'verified') OR (
      verified_byte_size IS NOT NULL
      AND verified_album_state IS NOT NULL
      AND ((verified_album_state = 'none' AND verified_album_id IS NULL) OR (verified_album_state = 'assigned' AND verified_album_id IS NOT NULL))
    )
  );
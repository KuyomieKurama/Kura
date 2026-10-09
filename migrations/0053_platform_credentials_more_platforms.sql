-- P1: the credential store also holds Patreon cookies, a Pixiv refresh token and optional YouTube cookies.
--
-- 0052 (IG-B) is not edited. The platform list is widened, and a `kind` column tells cookies from a token.
-- A token is stored like the cookies of 0052: AES-256-GCM ciphertext in cookies_ciphertext (the column name
-- is historic), bound to user and platform by the additional authenticated data. cookie_count is 1 for a
-- token (one secret) and earliest_expiry stays NULL (a refresh token carries no expiry that Kura can read).

ALTER TABLE platform_credentials DROP CONSTRAINT platform_credentials_platform_check;
ALTER TABLE platform_credentials
  ADD CONSTRAINT platform_credentials_platform_check CHECK (platform IN ('instagram', 'patreon', 'pixiv', 'youtube'));

ALTER TABLE platform_credentials
  ADD COLUMN kind text NOT NULL DEFAULT 'cookies' CHECK (kind IN ('cookies', 'token'));

-- Pixiv authenticates with a token, every other platform with cookies.
ALTER TABLE platform_credentials
  ADD CONSTRAINT platform_credentials_pixiv_token_check CHECK ((platform = 'pixiv') = (kind = 'token'));
ALTER TABLE platform_credentials
  ADD CONSTRAINT platform_credentials_token_shape_check CHECK (kind = 'cookies' OR (cookie_count = 1 AND earliest_expiry IS NULL));

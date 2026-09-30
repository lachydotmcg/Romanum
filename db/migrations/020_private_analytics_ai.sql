-- Separate permission to send owner analytics to the assistant's model provider.
-- Existing links stay opted out; public tools and MCP never receive these records.
ALTER TABLE linked_games ADD COLUMN ai_analysis boolean NOT NULL DEFAULT false;
ALTER TABLE linked_game_consents DROP CONSTRAINT linked_game_consents_setting_check;
ALTER TABLE linked_game_consents ADD CONSTRAINT linked_game_consents_setting_check
  CHECK (setting IN ('collect', 'share', 'ai_analysis'));

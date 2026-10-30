-- omp-stats tables written by omp/18.13.3 (make-fixture.ts). HOME was /tmp/tf-usage-fixture-4OY3PO.
BEGIN;
CREATE TABLE messages (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_file TEXT NOT NULL,
			entry_id TEXT NOT NULL,
			folder TEXT NOT NULL,
			model TEXT NOT NULL,
			provider TEXT NOT NULL,
			api TEXT NOT NULL,
			timestamp INTEGER NOT NULL,
			duration INTEGER,
			ttft INTEGER,
			stop_reason TEXT NOT NULL,
			error_message TEXT,
			input_tokens INTEGER NOT NULL,
			output_tokens INTEGER NOT NULL,
			cache_read_tokens INTEGER NOT NULL,
			cache_write_tokens INTEGER NOT NULL,
			total_tokens INTEGER NOT NULL,
			premium_requests REAL NOT NULL,
			cost_input REAL NOT NULL,
			cost_output REAL NOT NULL,
			cost_cache_read REAL NOT NULL,
			cost_cache_write REAL NOT NULL,
			cost_total REAL NOT NULL,
			cost_no_cache_input REAL,
			cost_unpriced INTEGER NOT NULL DEFAULT 0,
			agent_type TEXT NOT NULL DEFAULT 'main',
			service_tier TEXT,
			UNIQUE(session_file, entry_id)
		);
CREATE INDEX idx_messages_timestamp ON messages(timestamp);
CREATE INDEX idx_messages_entry_timestamp ON messages(entry_id, timestamp);
CREATE INDEX idx_messages_model ON messages(model);
CREATE INDEX idx_messages_folder ON messages(folder);
CREATE INDEX idx_messages_session ON messages(session_file);
CREATE INDEX idx_messages_timestamp_model_provider ON messages(timestamp, model, provider);
CREATE INDEX idx_messages_timestamp_folder ON messages(timestamp, folder);
CREATE INDEX idx_messages_stop_reason_timestamp ON messages(stop_reason, timestamp);
CREATE INDEX idx_messages_timestamp_agent_type ON messages(timestamp, agent_type);
INSERT INTO messages (id, session_file, entry_id, folder, model, provider, api, timestamp, duration, ttft, stop_reason, error_message, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, premium_requests, cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total, cost_no_cache_input, cost_unpriced, agent_type, service_tier) VALUES (1, '/tmp/tf-usage-fixture-4OY3PO/.omp/agent/sessions/-work-beta/2026-10-29T02-00-00-000Z_01bbbbbb-0000-7000-8000-00000000000b.jsonl', '0000000f', '-work-beta', 'grok-5', 'xai-oauth', 'openai-responses', 1793239200000, 7000, 900, 'stop', NULL, 5000, 1000, 0, 0, 6000, 0, 0, 0, 0, 0, 0, 0, 0, 'main', NULL);
INSERT INTO messages (id, session_file, entry_id, folder, model, provider, api, timestamp, duration, ttft, stop_reason, error_message, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, premium_requests, cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total, cost_no_cache_input, cost_unpriced, agent_type, service_tier) VALUES (2, '/tmp/tf-usage-fixture-4OY3PO/.omp/agent/sessions/-work-beta/2026-10-29T02-00-00-000Z_01bbbbbb-0000-7000-8000-00000000000b.jsonl', '00000010', '-work-beta', 'claude-opus-5-5', 'anthropic', 'anthropic-messages', 1793240400000, 9000, 2000, 'toolUse', NULL, 2000, 1500, 0, 0, 3500, 0, 0.020000000000000004, 0.020000000000000004, 0.005000000000000001, 0.005000000000000001, 0.05, 0.008, 0, 'main', NULL);
INSERT INTO messages (id, session_file, entry_id, folder, model, provider, api, timestamp, duration, ttft, stop_reason, error_message, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, premium_requests, cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total, cost_no_cache_input, cost_unpriced, agent_type, service_tier) VALUES (3, '/tmp/tf-usage-fixture-4OY3PO/.omp/agent/sessions/-work-alpha/2026-10-28T16-00-00-000Z_01aaaaaa-0000-7000-8000-00000000000a/0-Explore.jsonl', '0000000b', '-work-alpha', 'claude-sonnet-5', 'anthropic', 'anthropic-messages', 1793203380000, 3000, 600, 'toolUse', NULL, 800, 300, 0, 0, 1100, 0, 0.0024000000000000002, 0.0024000000000000002, 0.0006000000000000001, 0.0006000000000000001, 0.006, 0.0015999999999999999, 0, 'subagent', NULL);
INSERT INTO messages (id, session_file, entry_id, folder, model, provider, api, timestamp, duration, ttft, stop_reason, error_message, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, premium_requests, cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total, cost_no_cache_input, cost_unpriced, agent_type, service_tier) VALUES (4, '/tmp/tf-usage-fixture-4OY3PO/.omp/agent/sessions/-work-alpha/2026-10-28T16-00-00-000Z_01aaaaaa-0000-7000-8000-00000000000a/0-Explore.jsonl', '0000000c', '-work-alpha', 'claude-sonnet-5', 'anthropic', 'anthropic-messages', 1793203440000, 1500, 400, 'stop', NULL, 900, 150, 800, 0, 1850, 0, 0.0016, 0.0016, 0.0004, 0.0004, 0.004, 0.0034, 0, 'subagent', NULL);
INSERT INTO messages (id, session_file, entry_id, folder, model, provider, api, timestamp, duration, ttft, stop_reason, error_message, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, premium_requests, cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total, cost_no_cache_input, cost_unpriced, agent_type, service_tier) VALUES (5, '/tmp/tf-usage-fixture-4OY3PO/.omp/agent/sessions/-work-alpha/2026-10-28T16-00-00-000Z_01aaaaaa-0000-7000-8000-00000000000a.jsonl', '00000002', '-work-alpha', 'claude-opus-5-5', 'anthropic', 'anthropic-messages', 1793203320000, 4000, 800, 'toolUse', NULL, 1000, 200, 5000, 300, 6500, 0, 0.005600000000000001, 0.005600000000000001, 0.0014000000000000002, 0.0014000000000000002, 0.014, 0.0252, 0, 'main', NULL);
INSERT INTO messages (id, session_file, entry_id, folder, model, provider, api, timestamp, duration, ttft, stop_reason, error_message, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, premium_requests, cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total, cost_no_cache_input, cost_unpriced, agent_type, service_tier) VALUES (6, '/tmp/tf-usage-fixture-4OY3PO/.omp/agent/sessions/-work-alpha/2026-10-28T16-00-00-000Z_01aaaaaa-0000-7000-8000-00000000000a.jsonl', '00000003', '-work-alpha', 'claude-opus-5-5', 'anthropic', 'anthropic-messages', 1793203500000, 2000, 500, 'stop', NULL, 200, 100, 6000, 0, 6300, 0, 0.0026, 0.0026, 0.00065, 0.00065, 0.0065, 0.0248, 0, 'main', NULL);
INSERT INTO messages (id, session_file, entry_id, folder, model, provider, api, timestamp, duration, ttft, stop_reason, error_message, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, premium_requests, cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total, cost_no_cache_input, cost_unpriced, agent_type, service_tier) VALUES (7, '/tmp/tf-usage-fixture-4OY3PO/.omp/agent/sessions/-work-alpha/2026-10-28T16-00-00-000Z_01aaaaaa-0000-7000-8000-00000000000a.jsonl', '00000004', '-work-alpha', 'claude-opus-5-5', 'anthropic', 'anthropic-messages', 1793207100000, 300, NULL, 'error', 'overloaded_error', 50, 0, 0, 0, 50, 0, 0.00008, 0.00008, 0.00002, 0.00002, 0.0002, 0.00019999999999999998, 0, 'main', NULL);
INSERT INTO messages (id, session_file, entry_id, folder, model, provider, api, timestamp, duration, ttft, stop_reason, error_message, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, premium_requests, cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total, cost_no_cache_input, cost_unpriced, agent_type, service_tier) VALUES (8, '/tmp/tf-usage-fixture-4OY3PO/.omp/agent/sessions/-work-alpha/2026-10-28T16-00-00-000Z_01aaaaaa-0000-7000-8000-00000000000a.jsonl', '00000006', '-work-alpha', 'gpt-6-luna', 'openai-codex', 'openai-codex-responses', 1793207160000, NULL, NULL, 'stop', NULL, 400, 20, 0, 0, 420, 0, 0.00016, 0.00016, 0.00004, 0.00004, 0.0004, 0.00004, 0, 'main', NULL);
INSERT INTO messages (id, session_file, entry_id, folder, model, provider, api, timestamp, duration, ttft, stop_reason, error_message, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, premium_requests, cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total, cost_no_cache_input, cost_unpriced, agent_type, service_tier) VALUES (9, '/tmp/tf-usage-fixture-4OY3PO/.omp/agent/sessions/-work-alpha/2026-10-28T16-00-00-000Z_01aaaaaa-0000-7000-8000-00000000000a.jsonl', '00000005', '-work-alpha', 'gpt-6-astra', 'openai-codex', 'openai-codex-responses', 1793211000000, 6000, 1200, 'stop', NULL, 3000, 500, 0, 0, 3500, 1, 0.008, 0.008, 0.002, 0.002, 0.02, 0.030000000000000002, 0, 'main', 'priority');
INSERT INTO messages (id, session_file, entry_id, folder, model, provider, api, timestamp, duration, ttft, stop_reason, error_message, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, premium_requests, cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total, cost_no_cache_input, cost_unpriced, agent_type, service_tier) VALUES (10, '/tmp/tf-usage-fixture-4OY3PO/.omp/agent/sessions/-work-alpha/2026-10-28T16-00-00-000Z_01aaaaaa-0000-7000-8000-00000000000a/__advisor.jsonl', '0000000e', '-work-alpha', 'gpt-6-luna', 'openai-codex', 'openai-codex-responses', 1793203560000, 900, 300, 'stop', NULL, 1200, 80, 0, 0, 1280, 0, 0.0004, 0.0004, 0.0001, 0.0001, 0.001, 0.00012000000000000002, 0, 'advisor', NULL);
INSERT INTO messages (id, session_file, entry_id, folder, model, provider, api, timestamp, duration, ttft, stop_reason, error_message, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, premium_requests, cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total, cost_no_cache_input, cost_unpriced, agent_type, service_tier) VALUES (11, '/tmp/tf-usage-fixture-4OY3PO/.omp/agent/sessions/-work-alpha/2026-10-29T06-00-00-000Z_01cccccc-0000-7000-8000-00000000000c.jsonl', '00000012', '-work-alpha', 'claude-opus-5-5', 'anthropic', 'anthropic-messages', 1793257200000, 1000, 300, 'stop', NULL, 500, 50, 7000, 0, 7550, 0, 0.0012000000000000001, 0.0012000000000000001, 0.00030000000000000003, 0.00030000000000000003, 0.003, 0.03, 0, 'main', NULL);
CREATE TABLE tool_calls (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_file TEXT NOT NULL,
			entry_id TEXT NOT NULL,
			tool_call_id TEXT NOT NULL,
			folder TEXT NOT NULL,
			tool_name TEXT NOT NULL,
			model TEXT NOT NULL,
			provider TEXT NOT NULL,
			timestamp INTEGER NOT NULL,
			agent_type TEXT NOT NULL DEFAULT 'main',
			calls_in_turn INTEGER NOT NULL DEFAULT 1,
			args_chars INTEGER NOT NULL DEFAULT 0,
			result_chars INTEGER,
			is_error INTEGER,
			UNIQUE(session_file, tool_call_id)
		);
CREATE INDEX idx_tool_calls_timestamp ON tool_calls(timestamp);
CREATE INDEX idx_tool_calls_entry_timestamp ON tool_calls(entry_id, timestamp);
CREATE INDEX idx_tool_calls_tool_timestamp ON tool_calls(tool_name, timestamp);
INSERT INTO tool_calls (id, session_file, entry_id, tool_call_id, folder, tool_name, model, provider, timestamp, agent_type, calls_in_turn, args_chars, result_chars, is_error) VALUES (1, '/tmp/tf-usage-fixture-4OY3PO/.omp/agent/sessions/-work-beta/2026-10-29T02-00-00-000Z_01bbbbbb-0000-7000-8000-00000000000b.jsonl', '00000010', 'tc4', '-work-beta', 'edit', 'claude-opus-5-5', 'anthropic', 1793240400000, 'main', 1, 12, 6, 0);
INSERT INTO tool_calls (id, session_file, entry_id, tool_call_id, folder, tool_name, model, provider, timestamp, agent_type, calls_in_turn, args_chars, result_chars, is_error) VALUES (2, '/tmp/tf-usage-fixture-4OY3PO/.omp/agent/sessions/-work-alpha/2026-10-28T16-00-00-000Z_01aaaaaa-0000-7000-8000-00000000000a/0-Explore.jsonl', '0000000b', 'tc3', '-work-alpha', 'grep', 'claude-sonnet-5', 'anthropic', 1793203380000, 'subagent', 1, 12, 6, 0);
INSERT INTO tool_calls (id, session_file, entry_id, tool_call_id, folder, tool_name, model, provider, timestamp, agent_type, calls_in_turn, args_chars, result_chars, is_error) VALUES (3, '/tmp/tf-usage-fixture-4OY3PO/.omp/agent/sessions/-work-alpha/2026-10-28T16-00-00-000Z_01aaaaaa-0000-7000-8000-00000000000a.jsonl', '00000002', 'tc1', '-work-alpha', 'read', 'claude-opus-5-5', 'anthropic', 1793203320000, 'main', 2, 12, 6, 0);
INSERT INTO tool_calls (id, session_file, entry_id, tool_call_id, folder, tool_name, model, provider, timestamp, agent_type, calls_in_turn, args_chars, result_chars, is_error) VALUES (4, '/tmp/tf-usage-fixture-4OY3PO/.omp/agent/sessions/-work-alpha/2026-10-28T16-00-00-000Z_01aaaaaa-0000-7000-8000-00000000000a.jsonl', '00000002', 'tc2', '-work-alpha', 'bash', 'claude-opus-5-5', 'anthropic', 1793203320000, 'main', 2, 12, 6, 1);
CREATE TABLE user_messages (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_file TEXT NOT NULL,
			entry_id TEXT NOT NULL,
			folder TEXT NOT NULL,
			timestamp INTEGER NOT NULL,
			model TEXT,
			provider TEXT,
			chars INTEGER NOT NULL,
			words INTEGER NOT NULL,
			yelling INTEGER NOT NULL,
			profanity INTEGER NOT NULL,
			anguish INTEGER NOT NULL,
			negation INTEGER NOT NULL DEFAULT 0,
			repetition INTEGER NOT NULL DEFAULT 0,
			blame INTEGER NOT NULL DEFAULT 0,
			prose TEXT NOT NULL DEFAULT '',
			prose_hash TEXT NOT NULL DEFAULT '',
			UNIQUE(session_file, entry_id)
		);
CREATE INDEX idx_user_messages_timestamp ON user_messages(timestamp);
CREATE INDEX idx_user_messages_entry_timestamp ON user_messages(entry_id, timestamp);
CREATE INDEX idx_user_messages_timestamp_model ON user_messages(timestamp, model, provider);
CREATE INDEX idx_user_messages_prose_hash ON user_messages(prose_hash);
INSERT INTO user_messages (id, session_file, entry_id, folder, timestamp, model, provider, chars, words, yelling, profanity, anguish, negation, repetition, blame, prose, prose_hash) VALUES (1, '/tmp/tf-usage-fixture-4OY3PO/.omp/agent/sessions/-work-alpha/2026-10-28T16-00-00-000Z_01aaaaaa-0000-7000-8000-00000000000a.jsonl', '00000001', '-work-alpha', 1793203260000, 'claude-opus-5-5', 'anthropic', 19, 3, 0, 0, 0, 0, 0, 0, 'refactor the parser', 'aad6107f62ec578');
INSERT INTO user_messages (id, session_file, entry_id, folder, timestamp, model, provider, chars, words, yelling, profanity, anguish, negation, repetition, blame, prose, prose_hash) VALUES (2, '/tmp/tf-usage-fixture-4OY3PO/.omp/agent/sessions/-work-alpha/2026-10-28T16-00-00-000Z_01aaaaaa-0000-7000-8000-00000000000a.jsonl', '00000007', '-work-alpha', 1793203530000, 'claude-opus-5-5', 'anthropic', 13, 3, 0, 0, 0, 0, 0, 0, 'now the tests', 'e27a2b637c63fc4a');
CREATE TABLE meta (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);
INSERT INTO meta (key, value) VALUES ('agent_type_v1', 'complete');
INSERT INTO meta (key, value) VALUES ('catalog_cost_backfill', '18.13.3');
INSERT INTO meta (key, value) VALUES ('cost_no_cache_input_v1', 'complete');
INSERT INTO meta (key, value) VALUES ('fork_dedupe_v1', 'complete');
INSERT INTO meta (key, value) VALUES ('rollup_triggers_version', '3');
INSERT INTO meta (key, value) VALUES ('rollup_version', '2');
INSERT INTO meta (key, value) VALUES ('user_messages_v9', 'complete');
INSERT INTO meta (key, value) VALUES ('tool_calls_v2', 'complete');
INSERT INTO meta (key, value) VALUES ('user_message_links_v1', 'complete');
INSERT INTO meta (key, value) VALUES ('premium_requests_priority_v2', 'complete');
INSERT INTO meta (key, value) VALUES ('messages_cost_reingest_v1', 'complete');
INSERT INTO meta (key, value) VALUES ('messages_cost_unpriced_v1', 'complete');
COMMIT;

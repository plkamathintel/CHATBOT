import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { TOOL_DEFINITIONS, callTool } from './forecastTools';

const MAX_TOOL_ROUNDS = 6;

const SYSTEM_PROMPT = fs.readFileSync(
  path.join(process.cwd(), 'src', 'prompts', 'system-prompt.md'),
  'utf8'
);

// Same interpreter agent.py/mcp_service.py ran under (has pymysql/mcp + enough of
// langchain-core/openai that scripts/autobots_llm.py's sys.path fallback can fill
// in the rest from the autobots_sdk venv). Override via env on other hosts.
const PYTHON_EXECUTABLE =
  process.env.AUTOBOTS_PYTHON_EXECUTABLE ||
  '/p/hdk/pu_tu/prd/autobots_sdk/4.0.0/venv_autobots/bin/python3';
const BRIDGE_SCRIPT = path.join(process.cwd(), 'scripts', 'autobots_llm.py');
const MODEL_NAME = process.env.AUTOBOTS_MODEL || 'gpt-4o-mini';

// Spawns the Autobots SDK bridge (scripts/autobots_llm.py) for a single LLM call.
// Only works on hosts with access to the internal Autobots SDK path (Intel Linux
// compute) - fails fast (ENOENT) on a machine without that Python/SDK.
function invokeAutobots(messages) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON_EXECUTABLE, [BRIDGE_SCRIPT]);
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => reject(new Error(`Failed to start Autobots bridge: ${err.message}`)));
    child.on('close', () => {
      if (!stdout.trim()) {
        reject(new Error(`Autobots bridge produced no output: ${stderr || 'unknown error'}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch {
        reject(new Error(`Failed to parse Autobots bridge output: ${stdout}${stderr}`));
      }
    });

    child.stdin.write(JSON.stringify({ model: MODEL_NAME, messages, tools: TOOL_DEFINITIONS }));
    child.stdin.end();
  });
}

function historyToMessages(history) {
  return (history || [])
    .filter((turn) => turn && (turn.role === 'user' || turn.role === 'assistant'))
    .map((turn) => ({ role: turn.role, content: turn.content || '' }));
}

// Runs the cortex-agent tool-calling loop for a single user message and returns its reply.
// `history` is prior {role, content} turns used only as conversational context.
export async function runAgent(userMessage, history = []) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...historyToMessages(history),
    { role: 'user', content: userMessage },
  ];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await invokeAutobots(messages);
    if (response.error) {
      throw new Error(response.error);
    }

    const toolCalls = response.tool_calls || [];
    messages.push({ role: 'assistant', content: response.content || '', tool_calls: toolCalls });

    if (toolCalls.length === 0) {
      return response.content;
    }

    for (const call of toolCalls) {
      let toolContent;
      try {
        const args = call.arguments ? JSON.parse(call.arguments) : {};
        const result = await callTool(call.name, args);
        toolContent = JSON.stringify(result);
      } catch (error) {
        toolContent = JSON.stringify({ error: error.message });
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: toolContent });
    }
  }

  return "Sorry, I couldn't finish analyzing that within the allotted number of tool-calling steps. Try rephrasing or narrowing your question.";
}


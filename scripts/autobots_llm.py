#!/usr/bin/env python3
"""Stdin/stdout JSON bridge between Next.js (lib/agent.js) and the Autobots SDK.

Only importable/runnable on hosts with access to the internal Autobots SDK path
(Intel Linux compute), same constraint as the original agent.py/mcp_service.py.

Request (JSON on stdin):  {"model": str, "messages": [...], "tools": [...]}
  messages: [{"role": "system"|"user"|"assistant"|"tool", "content": str,
              "tool_calls"?: [{"id","name","arguments"}], "tool_call_id"?: str}]
  tools: OpenAI function-calling tool schema list (same shape LangChain's
         bind_tools accepts as-is).

Response (one JSON line on stdout):
  {"content": str|None, "tool_calls": [{"id","name","arguments"}, ...]}
  or {"error": str} on failure.
"""

import json
import sys

AUTOBOTS_SDK_PATH = "/p/hdk/pu_tu/prd/autobots_sdk/4.0.0"
AUTOBOTS_VENV_SITE_PACKAGES = (
    "/p/hdk/pu_tu/prd/autobots_sdk/4.0.0/venv_autobots/lib/python3.13/site-packages"
)


def _ensure_autobots_sdk_importable():
    if AUTOBOTS_SDK_PATH not in sys.path:
        sys.path.insert(0, AUTOBOTS_SDK_PATH)
    if AUTOBOTS_VENV_SITE_PACKAGES not in sys.path:
        # Appended (not inserted): only used as a fallback for packages missing
        # from this interpreter's own site-packages (langchain_core, tiktoken, ...).
        sys.path.append(AUTOBOTS_VENV_SITE_PACKAGES)


def _to_lc_messages(messages):
    from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

    lc_messages = []
    for m in messages:
        role = m.get("role")
        content = m.get("content") or ""
        if role == "system":
            lc_messages.append(SystemMessage(content=content))
        elif role == "user":
            lc_messages.append(HumanMessage(content=content))
        elif role == "assistant":
            tool_calls = [
                {
                    "id": tc["id"],
                    "name": tc["name"],
                    "args": json.loads(tc.get("arguments") or "{}"),
                }
                for tc in (m.get("tool_calls") or [])
            ]
            lc_messages.append(AIMessage(content=content, tool_calls=tool_calls))
        elif role == "tool":
            lc_messages.append(ToolMessage(content=content, tool_call_id=m["tool_call_id"]))
    return lc_messages


def main():
    payload = json.loads(sys.stdin.read())
    model_name = payload.get("model") or "gpt-4o-mini"
    messages = payload.get("messages") or []
    tools = payload.get("tools") or []

    try:
        _ensure_autobots_sdk_importable()
        from autobots_sdk.base.models.langchain.base_chat_model import AutobotsLangchain

        model = AutobotsLangchain(model=model_name)
        bound = model.bind_tools(tools) if tools else model

        response = bound.invoke(_to_lc_messages(messages))

        tool_calls = [
            {
                "id": tc.get("id"),
                "name": tc.get("name"),
                "arguments": json.dumps(tc.get("args") or {}),
            }
            for tc in (getattr(response, "tool_calls", None) or [])
        ]
        print(json.dumps({"content": response.content, "tool_calls": tool_calls}))
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))


if __name__ == "__main__":
    main()

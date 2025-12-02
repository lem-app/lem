# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2025 Lem
#
# This file is part of Lem.
#
# Lem is free software: you can redistribute it and/or modify it under
# the terms of the GNU Affero General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# Lem is distributed in the hope that it will be useful, but WITHOUT
# ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
# or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General
# Public License for more details.

"""
Service metadata registry.

Provides curated metadata (names, descriptions, categories) for Harbor services.
Merges with scanned data to produce complete ServiceDefinitions.
"""

from __future__ import annotations

import logging

from app.catalog.models import (
    ServiceCategory,
    ServiceDefinition,
    ServiceMetadata,
)
from app.catalog.scanner import scan_dependencies, scan_harbor_services

logger = logging.getLogger(__name__)


# =============================================================================
# Curated metadata for known services
# =============================================================================
# This registry provides human-friendly metadata that can't be extracted
# from compose files. Services not in this registry will use generated defaults.
#
# To add a new service:
# 1. Find it in Harbor docs: ~/.lem/harbor/docs/
# 2. Add entry with appropriate category, description, and tags
# =============================================================================

SERVICE_METADATA: dict[str, ServiceMetadata] = {
    # =========================================================================
    # BACKENDS - LLM inference engines
    # =========================================================================
    "ollama": ServiceMetadata(
        name="Ollama",
        category=ServiceCategory.BACKEND,
        description="Run Llama, Mistral, Gemma and other LLMs locally",
        tags=["llm", "inference", "api", "ollama"],
        has_api=True,
    ),
    "localai": ServiceMetadata(
        name="LocalAI",
        category=ServiceCategory.BACKEND,
        description="OpenAI-compatible API supporting multiple model formats",
        tags=["llm", "openai-compatible", "api", "tts", "stt", "images"],
        has_api=True,
    ),
    "vllm": ServiceMetadata(
        name="vLLM",
        category=ServiceCategory.BACKEND,
        description="High-throughput LLM serving with PagedAttention",
        tags=["llm", "high-performance", "api", "gpu"],
        has_api=True,
    ),
    "llamacpp": ServiceMetadata(
        name="llama.cpp",
        category=ServiceCategory.BACKEND,
        description="LLM inference in C/C++ with broad hardware support",
        tags=["llm", "inference", "api", "cpu", "gpu"],
        has_api=True,
    ),
    "tgi": ServiceMetadata(
        name="Text Generation Inference",
        category=ServiceCategory.BACKEND,
        description="HuggingFace's production inference server",
        tags=["llm", "huggingface", "api", "gpu"],
        has_api=True,
    ),
    "aphrodite": ServiceMetadata(
        name="Aphrodite Engine",
        category=ServiceCategory.BACKEND,
        description="Large-scale LLM inference engine",
        tags=["llm", "inference", "api", "gpu"],
        has_api=True,
    ),
    "tabbyapi": ServiceMetadata(
        name="TabbyAPI",
        category=ServiceCategory.BACKEND,
        description="Lightweight exllamav2 API server",
        tags=["llm", "exllama", "api", "gpu"],
        has_api=True,
    ),
    "mistralrs": ServiceMetadata(
        name="mistral.rs",
        category=ServiceCategory.BACKEND,
        description="Blazingly fast LLM inference in Rust",
        tags=["llm", "rust", "api", "fast"],
        has_api=True,
    ),
    "sglang": ServiceMetadata(
        name="SGLang",
        category=ServiceCategory.BACKEND,
        description="Fast serving framework for LLMs and VLMs",
        tags=["llm", "vlm", "api", "gpu"],
        has_api=True,
    ),
    "kobold": ServiceMetadata(
        name="KoboldCpp",
        category=ServiceCategory.BACKEND,
        description="Easy-to-use GGML/GGUF inference with built-in UI",
        tags=["llm", "ggml", "gguf", "ui"],
        has_api=True,
        has_ui=True,
    ),
    "ktransformers": ServiceMetadata(
        name="KTransformers",
        category=ServiceCategory.BACKEND,
        description="Flexible framework for LLM inference optimizations",
        tags=["llm", "inference", "api"],
        has_api=True,
    ),
    "airllm": ServiceMetadata(
        name="AirLLM",
        category=ServiceCategory.BACKEND,
        description="Run 70B models on 4GB GPU (layer-by-layer inference)",
        tags=["llm", "low-vram", "api"],
        has_api=True,
    ),
    "lmdeploy": ServiceMetadata(
        name="LMDeploy",
        category=ServiceCategory.BACKEND,
        description="Toolkit for compressing, deploying, and serving LLMs",
        tags=["llm", "inference", "api"],
        has_api=True,
    ),
    "nexa": ServiceMetadata(
        name="Nexa SDK",
        category=ServiceCategory.BACKEND,
        description="Toolkit for ONNX and GGML models",
        tags=["llm", "onnx", "ggml", "api"],
        has_api=True,
    ),
    "modularmax": ServiceMetadata(
        name="Modular MAX",
        category=ServiceCategory.BACKEND,
        description="Modular's platform for running LLMs locally",
        tags=["llm", "modular", "mojo", "api"],
        has_api=True,
    ),
    # Audio backends
    "tts": ServiceMetadata(
        name="openedai-speech",
        category=ServiceCategory.BACKEND,
        description="OpenAI-compatible text-to-speech server",
        tags=["tts", "audio", "api"],
        has_api=True,
    ),
    "stt": ServiceMetadata(
        name="Whisper STT",
        category=ServiceCategory.BACKEND,
        description="Speech-to-text with Whisper models",
        tags=["stt", "whisper", "audio", "api"],
        has_api=True,
    ),
    "speaches": ServiceMetadata(
        name="Speaches",
        category=ServiceCategory.BACKEND,
        description="OpenAI-compatible speech server (TTS + STT)",
        tags=["tts", "stt", "audio", "api"],
        has_api=True,
    ),
    "parler": ServiceMetadata(
        name="Parler TTS",
        category=ServiceCategory.BACKEND,
        description="High-quality text-to-speech with Parler models",
        tags=["tts", "audio", "api"],
        has_api=True,
    ),
    # =========================================================================
    # FRONTENDS - Chat and model UIs
    # =========================================================================
    "webui": ServiceMetadata(
        name="Open WebUI",
        category=ServiceCategory.FRONTEND,
        description="Feature-rich ChatGPT-like interface for local LLMs",
        tags=["chat", "ui", "rag", "multi-user"],
        depends_on=["ollama"],
        has_ui=True,
    ),
    "librechat": ServiceMetadata(
        name="LibreChat",
        category=ServiceCategory.FRONTEND,
        description="Multi-provider chat UI (OpenAI, Anthropic, local)",
        tags=["chat", "ui", "multi-provider"],
        has_ui=True,
    ),
    "chatui": ServiceMetadata(
        name="HuggingFace ChatUI",
        category=ServiceCategory.FRONTEND,
        description="SvelteKit chat interface from HuggingFace",
        tags=["chat", "ui", "huggingface"],
        has_ui=True,
    ),
    "lobechat": ServiceMetadata(
        name="Lobe Chat",
        category=ServiceCategory.FRONTEND,
        description="Modern AI chat framework with plugins and RAG",
        tags=["chat", "ui", "plugins", "rag"],
        has_ui=True,
    ),
    "hollama": ServiceMetadata(
        name="Hollama",
        category=ServiceCategory.FRONTEND,
        description="Minimal web UI for Ollama",
        tags=["chat", "ui", "minimal"],
        depends_on=["ollama"],
        has_ui=True,
    ),
    "chatnio": ServiceMetadata(
        name="Chat Nio",
        category=ServiceCategory.FRONTEND,
        description="LLM web interface with built-in marketplace",
        tags=["chat", "ui", "marketplace"],
        has_ui=True,
    ),
    "mikupad": ServiceMetadata(
        name="Mikupad",
        category=ServiceCategory.FRONTEND,
        description="Single-file LLM frontend",
        tags=["chat", "ui", "minimal"],
        has_ui=True,
    ),
    "anythingllm": ServiceMetadata(
        name="AnythingLLM",
        category=ServiceCategory.FRONTEND,
        description="All-in-one AI app with RAG, agents, and more",
        tags=["chat", "ui", "rag", "agents"],
        has_ui=True,
    ),
    "bionicgpt": ServiceMetadata(
        name="BionicGPT",
        category=ServiceCategory.FRONTEND,
        description="On-premise LLM web UI for teams",
        tags=["chat", "ui", "enterprise"],
        has_ui=True,
    ),
    "comfyui": ServiceMetadata(
        name="ComfyUI",
        category=ServiceCategory.FRONTEND,
        description="Node-based UI for Stable Diffusion workflows",
        tags=["image", "diffusion", "ui", "workflows"],
        has_ui=True,
    ),
    "oterm": ServiceMetadata(
        name="oterm",
        category=ServiceCategory.FRONTEND,
        description="Text-based terminal client for Ollama",
        tags=["chat", "tui", "terminal"],
        depends_on=["ollama"],
    ),
    "parllama": ServiceMetadata(
        name="Parllama",
        category=ServiceCategory.FRONTEND,
        description="TUI for chatting with Ollama models",
        tags=["chat", "tui", "terminal"],
        depends_on=["ollama"],
    ),
    # =========================================================================
    # SATELLITES - Tools, agents, and utilities
    # =========================================================================
    # Coding assistants
    "aider": ServiceMetadata(
        name="Aider",
        category=ServiceCategory.SATELLITE,
        description="AI pair programming in your terminal",
        tags=["coding", "cli", "agent"],
    ),
    "openhands": ServiceMetadata(
        name="OpenHands",
        category=ServiceCategory.SATELLITE,
        description="AI-powered software development platform",
        tags=["coding", "agent", "ui"],
        has_ui=True,
    ),
    "plandex": ServiceMetadata(
        name="Plandex",
        category=ServiceCategory.SATELLITE,
        description="AI-driven development in your terminal",
        tags=["coding", "cli", "planning"],
    ),
    "bolt": ServiceMetadata(
        name="Bolt.new",
        category=ServiceCategory.SATELLITE,
        description="Prompt, run, edit, and deploy full-stack web apps",
        tags=["coding", "ui", "fullstack"],
        has_ui=True,
    ),
    "gptme": ServiceMetadata(
        name="gptme",
        category=ServiceCategory.SATELLITE,
        description="Personal AI assistant in your terminal",
        tags=["cli", "assistant"],
    ),
    # Search and RAG
    "searxng": ServiceMetadata(
        name="SearXNG",
        category=ServiceCategory.SATELLITE,
        description="Privacy-respecting metasearch engine",
        tags=["search", "privacy", "rag"],
        has_ui=True,
        has_api=True,
    ),
    "perplexica": ServiceMetadata(
        name="Perplexica",
        category=ServiceCategory.SATELLITE,
        description="AI-powered search engine (Perplexity alternative)",
        tags=["search", "ai", "rag"],
        has_ui=True,
    ),
    "morphic": ServiceMetadata(
        name="Morphic",
        category=ServiceCategory.SATELLITE,
        description="AI search engine with generative UI",
        tags=["search", "ai", "rag"],
        has_ui=True,
    ),
    "ldr": ServiceMetadata(
        name="Local Deep Research",
        category=ServiceCategory.SATELLITE,
        description="Transform questions into comprehensive cited reports",
        tags=["research", "rag", "reports"],
        has_ui=True,
    ),
    "raglite": ServiceMetadata(
        name="RAGLite",
        category=ServiceCategory.SATELLITE,
        description="Python toolkit for RAG applications",
        tags=["rag", "python", "toolkit"],
        has_ui=True,
    ),
    "txtairag": ServiceMetadata(
        name="txtai RAG",
        category=ServiceCategory.SATELLITE,
        description="RAG WebUI built with txtai",
        tags=["rag", "ui", "txtai"],
        has_ui=True,
    ),
    # Workflow and automation
    "dify": ServiceMetadata(
        name="Dify",
        category=ServiceCategory.SATELLITE,
        description="Open-source LLM app development platform",
        tags=["workflows", "low-code", "agents"],
        has_ui=True,
    ),
    "flowise": ServiceMetadata(
        name="Flowise",
        category=ServiceCategory.SATELLITE,
        description="Drag & drop UI to build LLM flows",
        tags=["workflows", "low-code", "ui"],
        has_ui=True,
    ),
    "langflow": ServiceMetadata(
        name="LangFlow",
        category=ServiceCategory.SATELLITE,
        description="Low-code RAG and multi-agent app builder",
        tags=["workflows", "low-code", "rag"],
        has_ui=True,
    ),
    "n8n": ServiceMetadata(
        name="n8n",
        category=ServiceCategory.SATELLITE,
        description="Fair-code workflow automation with AI capabilities",
        tags=["workflows", "automation", "integrations"],
        has_ui=True,
    ),
    "pipelines": ServiceMetadata(
        name="Open WebUI Pipelines",
        category=ServiceCategory.SATELLITE,
        description="Plugin framework for OpenAI-compatible APIs",
        tags=["pipelines", "plugins", "api"],
        has_api=True,
    ),
    # Observability and evaluation
    "langfuse": ServiceMetadata(
        name="LangFuse",
        category=ServiceCategory.SATELLITE,
        description="LLM observability, metrics, evals, and prompt management",
        tags=["observability", "metrics", "evals"],
        has_ui=True,
        has_api=True,
    ),
    "promptfoo": ServiceMetadata(
        name="Promptfoo",
        category=ServiceCategory.SATELLITE,
        description="Test prompts, agents, and RAG applications",
        tags=["testing", "evals", "cli"],
        has_ui=True,
    ),
    "bench": ServiceMetadata(
        name="Harbor Bench",
        category=ServiceCategory.SATELLITE,
        description="Evaluate LLMs against custom tasks",
        tags=["evals", "benchmarks", "cli"],
    ),
    "lmeval": ServiceMetadata(
        name="lm-evaluation-harness",
        category=ServiceCategory.SATELLITE,
        description="Standard framework for few-shot LLM evaluation",
        tags=["evals", "benchmarks", "academic"],
    ),
    # API proxies and gateways
    "litellm": ServiceMetadata(
        name="LiteLLM",
        category=ServiceCategory.SATELLITE,
        description="Unified API proxy for multiple LLM providers",
        tags=["proxy", "api", "multi-provider"],
        has_api=True,
        has_ui=True,
    ),
    "optillm": ServiceMetadata(
        name="OptiLLM",
        category=ServiceCategory.SATELLITE,
        description="LLM proxy with advanced inference optimizations",
        tags=["proxy", "api", "optimization"],
        has_api=True,
    ),
    "boost": ServiceMetadata(
        name="Harbor Boost",
        category=ServiceCategory.SATELLITE,
        description="LLM API wrapper with custom workflows (CoT, etc.)",
        tags=["proxy", "api", "workflows"],
        has_api=True,
    ),
    "llamaswap": ServiceMetadata(
        name="llama-swap",
        category=ServiceCategory.SATELLITE,
        description="Run multiple llama.cpp servers with seamless switching",
        tags=["proxy", "api", "model-switching"],
        has_api=True,
    ),
    "traefik": ServiceMetadata(
        name="Traefik",
        category=ServiceCategory.SATELLITE,
        description="Modern HTTP reverse proxy and load balancer",
        tags=["proxy", "networking", "routing"],
        has_ui=True,
    ),
    # Vector databases
    "qdrant": ServiceMetadata(
        name="Qdrant",
        category=ServiceCategory.SATELLITE,
        description="High-performance vector database",
        tags=["vectordb", "embeddings", "search"],
        has_api=True,
        has_ui=True,
    ),
    # CLI tools
    "aichat": ServiceMetadata(
        name="aichat",
        category=ServiceCategory.SATELLITE,
        description="All-in-one LLM CLI with RAG, tools, and agents",
        tags=["cli", "chat", "rag"],
    ),
    "fabric": ServiceMetadata(
        name="Fabric",
        category=ServiceCategory.SATELLITE,
        description="LLM-driven text processing in the terminal",
        tags=["cli", "text-processing", "patterns"],
    ),
    "cmdh": ServiceMetadata(
        name="cmdh",
        category=ServiceCategory.SATELLITE,
        description="Create Linux commands from natural language",
        tags=["cli", "shell", "assistant"],
    ),
    "repopack": ServiceMetadata(
        name="Repopack",
        category=ServiceCategory.SATELLITE,
        description="Pack entire repository into AI-friendly format",
        tags=["cli", "context", "coding"],
    ),
    # Agents
    "agent": ServiceMetadata(
        name="Harbor Agent",
        category=ServiceCategory.SATELLITE,
        description="Harbor's built-in agent framework",
        tags=["agent", "automation"],
        has_ui=True,
    ),
    "agentzero": ServiceMetadata(
        name="Agent Zero",
        category=ServiceCategory.SATELLITE,
        description="General-purpose personal assistant with tools",
        tags=["agent", "assistant", "tools"],
        has_ui=True,
    ),
    "autogpt": ServiceMetadata(
        name="AutoGPT",
        category=ServiceCategory.SATELLITE,
        description="Autonomous AI agent platform",
        tags=["agent", "autonomous"],
        has_ui=True,
    ),
    "browseruse": ServiceMetadata(
        name="Browser Use",
        category=ServiceCategory.SATELLITE,
        description="AI-powered browser automation",
        tags=["agent", "browser", "automation"],
        has_ui=True,
    ),
    "opint": ServiceMetadata(
        name="Open Interpreter",
        category=ServiceCategory.SATELLITE,
        description="Natural language interface for computers",
        tags=["agent", "cli", "coding"],
    ),
    # MCP tools
    "mcpo": ServiceMetadata(
        name="mcpo",
        category=ServiceCategory.SATELLITE,
        description="Turn MCP servers into OpenAPI REST APIs",
        tags=["mcp", "api", "tools"],
        has_api=True,
    ),
    "metamcp": ServiceMetadata(
        name="MetaMCP",
        category=ServiceCategory.SATELLITE,
        description="Manage MCPs via WebUI, expose as single server",
        tags=["mcp", "management", "ui"],
        has_ui=True,
    ),
    "supergateway": ServiceMetadata(
        name="SuperGateway",
        category=ServiceCategory.SATELLITE,
        description="Simple and powerful API gateway for LLMs",
        tags=["mcp", "gateway", "cli"],
    ),
    # Utilities
    "jupyter": ServiceMetadata(
        name="JupyterLab",
        category=ServiceCategory.SATELLITE,
        description="Jupyter notebooks with Harbor service access",
        tags=["notebooks", "python", "dev"],
        has_ui=True,
    ),
    "webtop": ServiceMetadata(
        name="Webtop",
        category=ServiceCategory.SATELLITE,
        description="Linux desktop in a web browser",
        tags=["desktop", "browser", "linux"],
        has_ui=True,
    ),
    "k6": ServiceMetadata(
        name="K6",
        category=ServiceCategory.SATELLITE,
        description="Modern load testing tool",
        tags=["testing", "load", "performance"],
    ),
    "libretranslate": ServiceMetadata(
        name="LibreTranslate",
        category=ServiceCategory.SATELLITE,
        description="Free and open-source machine translation",
        tags=["translation", "api"],
        has_api=True,
        has_ui=True,
    ),
    "docling": ServiceMetadata(
        name="Docling",
        category=ServiceCategory.SATELLITE,
        description="Transform documents into LLM-ready format",
        tags=["documents", "parsing", "api"],
        has_api=True,
    ),
    "omniparser": ServiceMetadata(
        name="OmniParser",
        category=ServiceCategory.SATELLITE,
        description="Screen parsing tool for vision-based GUI agents",
        tags=["vision", "parsing", "agent"],
        has_api=True,
    ),
    "latentscope": ServiceMetadata(
        name="Latent Scope",
        category=ServiceCategory.SATELLITE,
        description="Visualize and explore datasets through latent spaces",
        tags=["visualization", "embeddings", "analysis"],
        has_ui=True,
    ),
    "textgrad": ServiceMetadata(
        name="TextGrad",
        category=ServiceCategory.SATELLITE,
        description="Automatic differentiation via text (textual gradients)",
        tags=["optimization", "research"],
    ),
    "sqlchat": ServiceMetadata(
        name="SQL Chat",
        category=ServiceCategory.SATELLITE,
        description="Chat-based SQL client with natural language",
        tags=["database", "sql", "chat"],
        has_ui=True,
    ),
    "airweave": ServiceMetadata(
        name="Airweave",
        category=ServiceCategory.SATELLITE,
        description="Transform app contents into agent-ready knowledge",
        tags=["knowledge", "integration", "agents"],
        has_ui=True,
    ),
    # Tunneling
    "cfd": ServiceMetadata(
        name="cloudflared",
        category=ServiceCategory.SATELLITE,
        description="Expose Harbor services over the internet",
        tags=["tunnel", "networking", "cloudflare"],
    ),
}


def _generate_default_metadata(service_id: str) -> ServiceMetadata:
    """
    Generate default metadata for a service not in the registry.

    Args:
        service_id: Service ID to generate metadata for

    Returns:
        ServiceMetadata with sensible defaults
    """
    return ServiceMetadata(
        name=service_id.replace("-", " ").replace("_", " ").title(),
        category=ServiceCategory.SATELLITE,  # Default to satellite
        description=f"Harbor service: {service_id}",
        tags=[service_id],
    )


def get_service_definition(service_id: str) -> ServiceDefinition | None:
    """
    Get the complete service definition by merging scanned data and metadata.

    Args:
        service_id: Service ID to look up

    Returns:
        ServiceDefinition or None if service not found
    """
    scanned = scan_harbor_services()

    if service_id not in scanned:
        return None

    scan_data = scanned[service_id]
    meta = SERVICE_METADATA.get(service_id) or _generate_default_metadata(service_id)

    # Get dependencies from metadata or scanned extension files
    scanned_deps = scan_dependencies()
    depends_on = meta.depends_on or scanned_deps.get(service_id, [])

    return ServiceDefinition(
        id=service_id,
        name=meta.name,
        category=meta.category,
        description=meta.description,
        container_port=scan_data.container_port,
        image=scan_data.image,
        tags=meta.tags,
        depends_on=depends_on,
        has_api=meta.has_api,
        has_ui=meta.has_ui,
    )


def get_all_services() -> list[ServiceDefinition]:
    """
    Get all available services with their definitions.

    Returns:
        List of all ServiceDefinitions, sorted by category then name
    """
    scanned = scan_harbor_services()
    services = []

    for service_id in scanned:
        definition = get_service_definition(service_id)
        if definition:
            services.append(definition)

    # Sort by category (backend first, then frontend, then satellite), then name
    category_order = {
        ServiceCategory.BACKEND: 0,
        ServiceCategory.FRONTEND: 1,
        ServiceCategory.SATELLITE: 2,
    }

    services.sort(key=lambda s: (category_order.get(s.category, 99), s.name.lower()))

    return services


def get_service_dependencies(service_id: str) -> list[str]:
    """
    Get the dependencies for a service.

    Checks both curated metadata and scanned extension files.

    Args:
        service_id: Service ID to get dependencies for

    Returns:
        List of dependency service IDs
    """
    # Check curated metadata first
    meta = SERVICE_METADATA.get(service_id)
    if meta and meta.depends_on:
        return meta.depends_on

    # Fall back to scanned dependencies
    scanned_deps = scan_dependencies()
    return scanned_deps.get(service_id, [])

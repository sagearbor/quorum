"""Tests for agent definition loader."""

import pytest
from agents import load_agent, list_agents, load_agents_by_tags, AgentDefinition


class TestLoadAgent:
    def test_load_safety_monitor(self):
        agent = load_agent("safety_monitor")
        assert agent.name == "Safety Monitor"
        assert agent.authority_rank == 7
        assert "safety_monitoring" in agent.domain_tags
        assert "adverse_events" in agent.domain_tags
        assert agent.model == "gpt-4o-mini"
        assert agent.escalation_model == "gpt-4o"
        assert agent.personality.tone == "formal"
        assert agent.personality.initiative == "proactive"

    def test_load_orchestrator(self):
        agent = load_agent("orchestrator")
        assert agent.authority_rank == 10
        assert agent.model == "gpt-4o"
        tool_names = [t.function.name for t in agent.tools]
        assert "suggest_dashboard" in tool_names
        assert agent.auto_create_docs is True

    def test_load_nonexistent_raises(self):
        with pytest.raises(FileNotFoundError):
            load_agent("nonexistent_agent")

    def test_instructions_not_empty(self):
        agent = load_agent("safety_monitor")
        assert len(agent.instructions) > 50

    def test_domain_tags_are_snake_case(self):
        for agent in list_agents():
            for tag in agent.domain_tags:
                assert tag == tag.lower(), f"Tag '{tag}' in {agent.name} is not lowercase"
                assert " " not in tag, f"Tag '{tag}' in {agent.name} contains spaces"


class TestListAgents:
    def test_list_returns_all(self):
        agents = list_agents()
        names = {a.name for a in agents}
        assert "Safety Monitor" in names
        assert "Orchestrator" in names
        assert "Budget Analyst" in names
        assert "Site Coordinator" in names
        assert "IRB Officer" in names
        assert "Patient Advocate" in names
        assert len(agents) >= 6

    def test_all_have_required_fields(self):
        for agent in list_agents():
            assert agent.name
            assert agent.version
            assert agent.description
            assert agent.instructions
            assert len(agent.domain_tags) >= 1
            assert 1 <= agent.authority_rank <= 10


class TestLoadByTags:
    def test_safety_tags_find_safety_monitor(self):
        agents = load_agents_by_tags(["adverse_events"])
        names = {a.name for a in agents}
        assert "Safety Monitor" in names

    def test_budget_tags_dont_find_safety(self):
        agents = load_agents_by_tags(["budget", "cost_analysis"])
        names = {a.name for a in agents}
        assert "Budget Analyst" in names
        assert "Safety Monitor" not in names

    def test_consent_tags_find_multiple(self):
        agents = load_agents_by_tags(["informed_consent"])
        names = {a.name for a in agents}
        # Both IRB and Patient Advocate care about consent
        assert "IRB Officer" in names
        assert "Patient Advocate" in names

    def test_empty_tags_returns_empty(self):
        agents = load_agents_by_tags([])
        assert agents == []


class TestAgentCard:
    def test_to_agent_card_format(self):
        agent = load_agent("safety_monitor")
        card = agent.to_agent_card()
        assert card["name"] == "Safety Monitor"
        assert "capabilities" in card
        assert "skills" in card
        assert len(card["skills"]) > 0
        assert card["skills"][0]["id"] == "safety_review"

Feature: Pikiio relational truth soak

  Scenario: The soak lasts at least twenty four hours
    Given a clean twenty five hour relational soak
    When the soak ends before twenty four hours
    Then soak acceptance is refused as SOAK_DURATION_TOO_SHORT

  Scenario: Soak cycles are natural
    Given a clean twenty five hour relational soak
    When one soak cycle is manufactured
    Then soak acceptance is refused as SOURCE_CYCLE_NOT_NATURAL

  Scenario: Two distinct source cuts span the soak
    Given a clean twenty five hour relational soak
    When every cycle reuses one source cut
    Then soak acceptance is refused as NATURAL_CYCLES_NOT_DISTINCT

  Scenario: A natural morning refresh succeeds
    Given a clean twenty five hour relational soak
    When no natural morning refresh succeeds
    Then soak acceptance is refused as NATURAL_MORNING_REFRESH_MISSING

  Scenario: The morning refresh lies inside the soak
    Given a clean twenty five hour relational soak
    When the morning refresh falls outside the soak
    Then soak acceptance is refused as MORNING_REFRESH_OUTSIDE_SOAK

  Scenario: Every cycle keeps truth health live
    Given a clean twenty five hour relational soak
    When one health response is degraded
    Then soak acceptance is refused as TRUTH_HEALTH_NOT_LIVE

  Scenario: Every active Brain row remains source backed
    Given a clean twenty five hour relational soak
    When Brain reports an active source gap
    Then soak acceptance is refused as BRAIN_SOURCE_GAP

  Scenario: Canonical contradictions remain zero
    Given a clean twenty five hour relational soak
    When Brain reports an active contradiction
    Then soak acceptance is refused as BRAIN_CONTRADICTION

  Scenario: Live backlog never grows
    Given a clean twenty five hour relational soak
    When a cycle ends with more live backlog
    Then soak acceptance is refused as LIVE_BACKLOG_GREW

  Scenario: Dead letters remain zero
    Given a clean twenty five hour relational soak
    When a dead letter appears
    Then soak acceptance is refused as DEAD_LETTER_PRESENT

  Scenario: Every relational audit succeeds
    Given a clean twenty five hour relational soak
    When an audit fails
    Then soak acceptance is refused as AUDIT_NOT_SUCCESSFUL

  Scenario: Audit and publication use one source cut
    Given a clean twenty five hour relational soak
    When an audit cites another source cut
    Then soak acceptance is refused as AUDIT_PUBLICATION_MISMATCH

  Scenario: Browser and API packet identities agree
    Given a clean twenty five hour relational soak
    When the browser packet hash differs
    Then soak acceptance is refused as BROWSER_PUBLICATION_MISMATCH

  Scenario: The legacy writer remains absent for the full soak
    Given a clean twenty five hour relational soak
    When a legacy writer invocation appears
    Then soak acceptance is refused as LEGACY_WRITER_REVIVED

  Scenario: Historical replay never overlaps live recovery
    Given a clean twenty five hour relational soak
    When replay overlaps live recovery
    Then soak acceptance is refused as REPLAY_LIVE_RECOVERY_COLLISION

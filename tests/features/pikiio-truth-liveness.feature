Feature: Pikiio relational truth liveness

  Scenario: Natural source evidence is mandatory
    Given two complete natural relational cycles
    When either cycle is manufactured
    Then liveness is refused as SOURCE_CYCLE_NOT_NATURAL

  Scenario: Gmail TMS and tracking frontiers are all present
    Given two complete natural relational cycles
    When a required source frontier is absent
    Then liveness is refused as SOURCE_FRONTIER_MISSING

  Scenario: Every frontier receives an accepted receipt
    Given two complete natural relational cycles
    When a required source acceptance is absent
    Then liveness is refused as SOURCE_ACCEPTANCE_MISSING

  Scenario: Acceptance follows the observed frontier
    Given two complete natural relational cycles
    When an acceptance predates its frontier
    Then liveness is refused as SOURCE_ACCEPTANCE_ORDER_INVALID

  Scenario: The truth ledger receipt is committed
    Given two complete natural relational cycles
    When the truth ledger receipt is disabled
    Then liveness is refused as TRUTH_LEDGER_NOT_COMMITTED

  Scenario: The truth ledger binds TMS and tracking cuts
    Given two complete natural relational cycles
    When the committed tracking cut differs
    Then liveness is refused as TRUTH_LEDGER_SOURCE_MISMATCH

  Scenario: A source cut seals only after the ledger commits
    Given two complete natural relational cycles
    When the source cut predates the ledger commit
    Then liveness is refused as SOURCE_CUT_ORDER_INVALID

  Scenario: The canonical source cut is complete
    Given two complete natural relational cycles
    When a canonical source cut is degraded
    Then liveness is refused as SOURCE_CUT_INCOMPLETE

  Scenario: Publication follows the exact source cut
    Given two complete natural relational cycles
    When publication cites another source cut
    Then liveness is refused as PUBLICATION_SOURCE_CUT_MISMATCH

  Scenario: Publication follows acceptance and sealing
    Given two complete natural relational cycles
    When publication predates source-cut sealing
    Then liveness is refused as PUBLICATION_ORDER_INVALID

  Scenario: The legacy packet writer stays retired
    Given two complete natural relational cycles
    When a legacy writer invocation appears
    Then liveness is refused as LEGACY_WRITER_REVIVED

  Scenario: Live queues drain without dead letters
    Given two complete natural relational cycles
    When live backlog grows or a dead letter appears
    Then liveness is refused as LIVE_QUEUE_UNSAFE

  Scenario: Historical replay cannot collide with live recovery
    Given two complete natural relational cycles
    When historical replay and live recovery overlap
    Then liveness is refused as REPLAY_LIVE_RECOVERY_COLLISION

  Scenario: Two distinct natural cycles are required
    Given two complete natural relational cycles
    When both cycles reuse one source-cut identity
    Then liveness is refused as NATURAL_CYCLES_NOT_DISTINCT

  Scenario: Audit APIs and browser agree with publication
    Given two complete natural relational cycles
    When the browser packet hash differs from publication
    Then liveness is refused as BROWSER_PUBLICATION_MISMATCH

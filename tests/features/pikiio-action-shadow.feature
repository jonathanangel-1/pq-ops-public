Feature: ACTION-02 production action shadow is isolated and receipt-complete

  Scenario: Shadow comparison cannot write the action queue
    Given a frozen action queue snapshot
    When the claim-native planner runs in production shadow
    Then the action queue hash remains byte-identical

  Scenario: Shadow comparison cannot create a Gmail draft
    Given a frozen Gmail draft queue snapshot
    When the claim-native planner runs in production shadow
    Then the Gmail draft queue hash remains byte-identical

  Scenario: Shadow comparison cannot enqueue a send
    Given a frozen outbound send queue snapshot
    When the claim-native planner runs in production shadow
    Then the outbound send queue hash remains byte-identical

  Scenario: Every frozen corpus case has one comparison receipt
    Given the immutable twenty-seven-case action corpus
    When the shadow evaluator completes a comparison batch
    Then exactly one receipt exists for every case without duplicates

  Scenario: Shadow receipts preserve accepted claim provenance
    Given claim-native decisions with accepted evidence receipts
    When the shadow evaluator records comparisons
    Then every comparison preserves the exact accepted claim identifiers

  Scenario: Wait cohort is measured independently
    Given a shadow batch containing wait decisions
    When the evaluator classifies decision cohorts
    Then the wait cohort count and members are exact

  Scenario: Act cohort is measured independently
    Given a shadow batch containing proposal decisions
    When the evaluator classifies decision cohorts
    Then the act cohort count and members are exact

  Scenario: Blocked cohort is measured independently
    Given a shadow batch containing blocked decisions
    When the evaluator classifies decision cohorts
    Then the blocked cohort count and members are exact

  Scenario: Completed cohort is measured independently
    Given a shadow batch containing completed decisions
    When the evaluator classifies decision cohorts
    Then the completed cohort count and members are exact

  Scenario: Unsafe recipient finding fails the batch
    Given a comparison that selects a recipient outside accepted ownership
    When the shadow safety grader evaluates the comparison
    Then the batch fails with an unsafe-recipient finding

  Scenario: Unsafe thread finding fails the batch
    Given a comparison that selects a thread outside owner provenance
    When the shadow safety grader evaluates the comparison
    Then the batch fails with an unsafe-thread finding

  Scenario: Premature timing finding fails the batch
    Given a comparison that chases inside a fresh promise window
    When the shadow safety grader evaluates the comparison
    Then the batch fails with an unsafe-timing finding

  Scenario: POD-received wording from a promise fails the batch
    Given a comparison that labels a POD promise as received
    When the shadow safety grader evaluates the comparison
    Then the batch fails with an unsafe-wording finding

  Scenario: Duplicate proposal finding fails the batch
    Given two shadow proposals with the same deterministic action identifier
    When the shadow safety grader evaluates the comparison
    Then the batch fails with a duplicate-action finding

  Scenario: Identical shadow inputs produce identical receipts
    Given the same frozen corpus planner version and source cut
    When the shadow evaluator runs the batch twice
    Then both content-addressed comparison receipts are byte-equivalent

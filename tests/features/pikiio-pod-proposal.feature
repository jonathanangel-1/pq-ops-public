Feature: ACTION-03 operator-visible POD proposals remain read-only and reversible

  Scenario: Disabled server flag preserves the prior operator surface
    Given the POD proposal server flag is disabled
    When the operator shipment projection is built
    Then the projection is byte-identical to the prior surface

  Scenario: Enabled flag exposes only the POD proposal family
    Given the POD proposal server flag is enabled
    When an eligible claim-native POD proposal is projected
    Then exactly one POD proposal family is operator-visible

  Scenario: API and view model share the same proposal identifier
    Given an eligible claim-native POD proposal
    When API and view-model projections are built
    Then both projections expose the same deterministic identifier

  Scenario: API and view model share accepted evidence
    Given an eligible claim-native POD proposal with accepted claim identifiers
    When API and view-model projections are built
    Then both projections expose the exact same accepted evidence

  Scenario: API and view model share the owner recipient
    Given an accepted destination-leg owner candidate
    When API and view-model projections are built
    Then both projections expose the same owner-derived recipient

  Scenario: API and view model share thread provenance
    Given an accepted owner claim with source thread provenance
    When API and view-model projections are built
    Then both projections expose the same source thread

  Scenario: API and view model share the proposal reason
    Given an evidence-backed POD proposal reason
    When API and view-model projections are built
    Then both projections expose the same evidence-backed reason

  Scenario: API and view model share the courtesy window
    Given an expired accepted POD promise and its courtesy window
    When API and view-model projections are built
    Then both projections expose the same courtesy-window receipt

  Scenario: API and view model share the wait condition
    Given an open POD gate and next expected fact
    When API and view-model projections are built
    Then both projections expose the same wait condition

  Scenario: Proposal inspection cannot create a Gmail draft
    Given an operator-visible POD proposal
    When the proposal is rendered and inspected
    Then no Gmail draft API call or draft row occurs

  Scenario: Proposal inspection cannot send Gmail
    Given an operator-visible POD proposal
    When the proposal is rendered and inspected
    Then no Gmail send API call or send row occurs

  Scenario: Proposal inspection cannot mutate TMS or freight state
    Given an operator-visible POD proposal
    When the proposal is rendered and inspected
    Then no TMS freight approval release or booking mutation occurs

  Scenario: Dismissing a proposal cannot rewrite shipment truth
    Given an operator-visible POD proposal and frozen truth packet
    When the operator dismisses the local proposal
    Then shipment truth and accepted claims remain byte-identical

  Scenario: A POD promise cannot render as POD received
    Given delivery confirmation and an accepted promise to send POD
    When the POD proposal view model is built
    Then it renders POD pending and never POD received

  Scenario: Delivered with open POD remains visible
    Given terminal delivery and an open POD gate
    When the operator shipment projection is built
    Then the POD obligation remains on the working surface

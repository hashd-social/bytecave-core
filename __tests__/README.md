# HASHD Vault Test Suite

Comprehensive test suite covering all vault requirements and functionality.

## Test Files

### Unit Tests

#### `cid-generation.test.ts`
Tests for Content Identifier (CID) generation and validation.
- **Coverage**: Requirement 1 (Blob Format)
- **Tests**:
  - CID generation consistency
  - SHA-256 hash validation
  - Ciphertext validation (base64)
  - CID verification
  - Edge cases (empty, invalid input)

#### `storage-proofs.test.ts`
Tests for cryptographic storage proof system.
- **Coverage**: Requirement 4 (Storage Proofs)
- **Tests**:
  - Challenge generation with timestamp truncation
  - Ed25519 proof signing
  - Proof verification
  - Freshness validation
  - Invalid signature rejection
  - Stale/future proof rejection

#### `reputation-scoring.test.ts`
Tests for node reputation and reliability scoring.
- **Coverage**: Requirement 5 (Reputation System)
- **Tests**:
  - Event recording (success/failure)
  - Score calculation with weights
  - Reputation penalties and rewards
  - Score decay over time
  - Score clamping (0-1000)
  - Statistics aggregation

#### `sharding.test.ts`
Tests for storage sharding and horizontal partitioning.
- **Coverage**: Requirement 7 (Storage Sharding)
- **Tests**:
  - Shard key calculation (deterministic)
  - Node shard responsibility checking
  - CID storage validation
  - Shard range expansion
  - Configuration parsing
  - Distribution statistics

#### `node-selection.test.ts`
Tests for deterministic node selection algorithm.
- **Coverage**: Requirement 6 (Replication Factor)
- **Tests**:
  - Deterministic selection consistency
  - Reputation-based filtering
  - Shard-aware selection
  - Replacement node selection
  - Replication completion checking
  - Node ranking

### Integration Tests

#### `integration.test.ts`
End-to-end workflow tests combining multiple components.
- **Coverage**: All requirements working together
- **Tests**:
  - Complete blob storage workflow
  - Proof generation and verification workflow
  - Replication with sharding workflow
  - Shard distribution analysis
  - Reputation impact on selection

## Running Tests

### Run all tests
```bash
yarn test
```

### Run specific test file
```bash
yarn test cid-generation
```

### Run with coverage
```bash
yarn test --coverage
```

### Watch mode
```bash
yarn test --watch
```

## Test Coverage Goals

- **Unit Tests**: >80% code coverage
- **Integration Tests**: All critical workflows
- **Edge Cases**: Invalid inputs, boundary conditions
- **Error Handling**: All error paths tested

## Requirements Coverage

| Requirement | Test File | Status |
|-------------|-----------|--------|
| R1: Blob Format | `cid-generation.test.ts` | ✅ |
| R2: Node Responsibilities | `cid-generation.test.ts` | ✅ |
| R3: Node Registry | (Smart contract tests) | 📝 |
| R4: Storage Proofs | `storage-proofs.test.ts` | ✅ |
| R5: Reputation | `reputation-scoring.test.ts` | ✅ |
| R6: Replication Factor | `node-selection.test.ts` | ✅ |
| R7: Storage Sharding | `sharding.test.ts` | ✅ |

## Writing New Tests

### Test Structure
```typescript
describe('Feature Name', () => {
  test('should do something specific', () => {
    // Arrange
    const input = 'test data';
    
    // Act
    const result = functionUnderTest(input);
    
    // Assert
    expect(result).toBe(expected);
  });
});
```

### Best Practices
1. **Descriptive names**: Use clear, specific test names
2. **Single responsibility**: One assertion per test when possible
3. **Arrange-Act-Assert**: Follow AAA pattern
4. **Independence**: Tests should not depend on each other
5. **Edge cases**: Test boundary conditions and error cases

## Continuous Integration

Tests run automatically on:
- Pull requests
- Commits to main branch
- Pre-deployment checks

## Future Test Additions

- [ ] API endpoint tests (supertest)
- [ ] Database/storage layer tests
- [ ] Performance/load tests
- [ ] Security tests
- [ ] Smart contract integration tests

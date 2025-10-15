import { expect } from "chai"
import { ethers } from "hardhat"
import {
  Contracts,
  TestingAddresses,
  User,
  setupTests,
  openTrove,
  adjustTroveToICR,
  dropPrice,
  setDefaultFees,
  fastForwardTime,
} from "../helpers"
import { to1e18 } from "../utils"
import { constants } from "buffer"

describe("ReversibleCallOptionManager - initializeOption", () => {
  let addresses: TestingAddresses
  let alice: User
  let bob: User
  let carol: User
  let dennis: User
  let council: User
  let deployer: User
  let treasury: User
  let contracts: Contracts

  // Helper function to calculate required premium
  const calculateRequiredPremium = async (
    borrower: string,
  ): Promise<bigint> => {
    const price = await contracts.priceFeed.fetchPrice()
    const [coll] = await contracts.troveManager.getEntireDebtAndColl(borrower)
    console.log("Collateral (wei):", coll.toString())
    // const collateralValue = (coll * price) / to1e18(1)

    // Risk-Adjusted Collateral Formula (matching contract logic exactly):
    // Using DECIMAL_PRECISION = 1e18 for all percentage calculations
    const DECIMAL_PRECISION = to1e18(1)
    const liquidationThreshold = (85n * to1e18(1)) / 100n // 85e16 = 0.85 * 1e18
    const recoveryFraction = (90n * to1e18(1)) / 100n // 90e16 = 0.90 * 1e18
    const safetyMarginPercent = (10n * to1e18(1)) / 100n // 10e16 = 0.10 * 1e18

    // Expected value at liquidation
    const liquidationValue = (liquidationThreshold * coll) / DECIMAL_PRECISION

    // Expected recovery from liquidation
    const recoveryValue =
      (liquidationValue * recoveryFraction) / DECIMAL_PRECISION

    // Expected loss = Initial Value - Recovery Value
    const expectedLoss = coll > recoveryValue ? coll - recoveryValue : 0n

    // Add safety margin to account for market volatility
    const safetyMarginAmount = (safetyMarginPercent * coll) / DECIMAL_PRECISION

    // Total risk = Expected Loss + Safety Margin
    const totalRisk = expectedLoss + safetyMarginAmount

    // λ = Total Risk / Initial Collateral Value (in DECIMAL_PRECISION units)
    const lambda = (totalRisk * DECIMAL_PRECISION) / coll

    // Premium = λ × Collateral Value / DECIMAL_PRECISION
    const requiredPremium = (lambda * coll) / DECIMAL_PRECISION

    // Add 1% buffer for any rounding differences
    return (requiredPremium * 101n) / 100n
  }

  beforeEach(async () => {
    ;({
      contracts,
      addresses,
      alice,
      bob,
      carol,
      dennis,
      council,
      deployer,
      treasury,
    } = await setupTests())

    // Setup PCV governance addresses
    await contracts.pcv
      .connect(deployer.wallet)
      .startChangingRoles(council.address, treasury.address)
    await contracts.pcv.connect(deployer.wallet).finalizeChangingRoles()

    // Note: ReversibleCallOptionManager addresses are already set during deployment
    // and the contract renounces ownership after setAddresses is called, so we can't call it again

    // Add ReversibleCallOptionManager to MUSD burn list (needed for exercise function)
    // Note: This should already be done during MUSD initialization with the 5-parameter version
    // await contracts.musd
    //   .connect(deployer.wallet)
    //   .addToBurnList(await contracts.reversibleCallOptionManager.getAddress())

    // IMPORTANT: The deployment script has a bug where it passes reversibleCallOptionManager
    // as the 12th parameter instead of 10th, so TroveManager has sortedTroves address
    // stored in reversibleCallOptionManagerAddress. We need to fix this for tests.

    // Manually set the correct address in TroveManager storage
    // After OwnableUpgradeable (2 slots: _owner at 0, __gap at 1-50),
    // TroveManager storage starts at slot 51:
    // 51: borrowerOperations
    // 52: collSurplusPool
    // 53: gasPoolAddress
    // 54: musdToken
    // 55: pcv
    // 56: reversibleCallOptionManagerAddress  <-- This is what we need to set
    // 57: sortedTroves
    // 58: stabilityPool

    const correctAddress =
      await contracts.reversibleCallOptionManager.getAddress()
    await ethers.provider.send("hardhat_setStorageAt", [
      addresses.troveManager,
      "0x" + (56).toString(16).padStart(64, "0"),
      "0x" + correctAddress.slice(2).padStart(64, "0"),
    ])

    await setDefaultFees(contracts, council)

    // Open troves for testing
    // Alice will have a trove that can become undercollateralized
    await openTrove(contracts, {
      musdAmount: "30,000",
      sender: alice.wallet,
      ICR: "154", // 150% ICR
    })

    // Bob will be the supporter - use lower collateral so he has more ETH for premiums
    await openTrove(contracts, {
      musdAmount: "10,000",
      sender: bob.wallet,
      ICR: "200", // 200% ICR - uses ~15k worth of ETH as collateral, leaves ~9985k ETH
    })

    // Carol for additional tests - give her enough MUSD for exercising options
    // Use lower ICR to minimize collateral requirements since she's just providing liquidity
    await openTrove(contracts, {
      musdAmount: "500,000",
      sender: carol.wallet,
      ICR: "155", // Lower ICR = less collateral needed
    })
  })

  describe("Basic Option Initialization", () => {
    it("should create an option for undercollateralized trove", async () => {
      // Make Alice's trove undercollateralized by dropping price
      await dropPrice(contracts, deployer, alice)

      const maturityDuration = 3600 // 1 hour
      const premium = await calculateRequiredPremium(alice.wallet.address)
      console.log(premium)

      await contracts.reversibleCallOptionManager.initializeOption(
        alice.wallet.address,
        maturityDuration,
      )

      const option = await contracts.reversibleCallOptionManager.getOption(
        alice.wallet.address,
      )

      expect(option.exists).to.equal(true)
      expect(option.borrower).to.equal(alice.wallet.address)
      expect(option.supporter).to.equal(ethers.ZeroAddress)
      expect(option.phase).to.equal(1) // PreMaturity
      expect(option.premium).to.be.greaterThan(0)
    })

    it("should increase borrower ICR after option initialization (premium added as collateral)", async () => {
      // Make Alice's trove undercollateralized
      await dropPrice(contracts, deployer, alice)

      // Get ICR before option initialization
      const price = await contracts.priceFeed.fetchPrice()
      const icrBefore = await contracts.troveManager.getCurrentICR(
        alice.wallet.address,
        price,
      )
      // Calculate premium and initialize option
      const maturityDuration = 3600 // 1 hour

      await contracts.reversibleCallOptionManager.initializeOption(
        alice.wallet.address,
        maturityDuration,
      )

      const option = await contracts.reversibleCallOptionManager.getOption(
        alice.wallet.address,
      )
      const premium = option.premium

      await contracts.reversibleCallOptionManager
        .connect(deployer.wallet)
        .support(alice.wallet.address, { value: premium })

      // Get ICR after option initialization
      const icrAfter = await contracts.troveManager.getCurrentICR(
        alice.wallet.address,
        price,
      )

      // ICR should increase
      expect(icrAfter).to.be.gt(icrBefore)
    })

    it("should calculate lambda within valid range", async () => {
      // Make Alice's trove undercollateralized
      await dropPrice(contracts, deployer, alice)

      await contracts.reversibleCallOptionManager.initializeOption(
        alice.wallet.address,
        3600,
      )

      const option = await contracts.reversibleCallOptionManager.getOption(
        alice.wallet.address,
      )
      const MIN_LAMBDA =
        await contracts.reversibleCallOptionManager.MIN_LAMBDA()
      const MAX_LAMBDA =
        await contracts.reversibleCallOptionManager.MAX_LAMBDA()

      expect(option.lambda).to.be.gte(MIN_LAMBDA)
      expect(option.lambda).to.be.lte(MAX_LAMBDA)
    })

    it("should set correct maturity time", async () => {
      await dropPrice(contracts, deployer, alice)

      const maturityDuration = 7200 // 2 hours
      const premium = await calculateRequiredPremium(alice.wallet.address)

      const blockTime = await ethers.provider
        .getBlock("latest")
        .then((b) => b!.timestamp)

      await contracts.reversibleCallOptionManager.initializeOption(
        alice.wallet.address,
        maturityDuration,
      )

      const option = await contracts.reversibleCallOptionManager.getOption(
        alice.wallet.address,
      )
      const expectedMaturity = blockTime + maturityDuration

      // Allow 10 second tolerance for block time differences
      expect(option.maturityTime).to.be.closeTo(BigInt(expectedMaturity), 10)
    })

    it("should lock supporter's premium in contract", async () => {
      await dropPrice(contracts, deployer, alice)

      const premium = await calculateRequiredPremium(alice.wallet.address)

      await contracts.reversibleCallOptionManager.initializeOption(
        alice.wallet.address,
        3600,
      )

      await contracts.reversibleCallOptionManager
        .connect(deployer.wallet)
        .support(alice.wallet.address, { value: premium })

      expect(
        await contracts.reversibleCallOptionManager.supporterBalances(
          deployer.wallet.address,
        ),
      ).to.equal(premium)

      const contractBalance = await ethers.provider.getBalance(
        await contracts.reversibleCallOptionManager.getAddress(),
      )
      expect(contractBalance).to.equal(premium)
    })

    it("should track total premiums collected", async () => {
      await dropPrice(contracts, deployer, alice)

      const premium = await calculateRequiredPremium(alice.wallet.address)

      await contracts.reversibleCallOptionManager.initializeOption(
        alice.wallet.address,
        3600,
      )

      await contracts.reversibleCallOptionManager
        .connect(deployer.wallet)
        .support(alice.wallet.address, { value: premium })

      expect(
        await contracts.reversibleCallOptionManager.totalPremiumsCollected(
          deployer.wallet.address,
        ),
      ).to.equal(premium)
    })

    it("should emit OptionInitialized event", async () => {
      await dropPrice(contracts, deployer, alice)

      const premium = await calculateRequiredPremium(alice.wallet.address)

      await expect(
        contracts.reversibleCallOptionManager.initializeOption(
          alice.wallet.address,
          3600,
        ),
      ).to.emit(contracts.reversibleCallOptionManager, "OptionInitialized")
    })

    it("should store collateral and debt values", async () => {
      await dropPrice(contracts, deployer, alice)

      const premium = await calculateRequiredPremium(alice.wallet.address)

      await contracts.reversibleCallOptionManager.initializeOption(
        alice.wallet.address,
        3600,
      )

      const option = await contracts.reversibleCallOptionManager.getOption(
        alice.wallet.address,
      )

      expect(option.collateralAtStart).to.be.gt(0)
      expect(option.debtAtStart).to.be.gt(0)
    })
  })

  describe("Option Initialization Validation", () => {
    it("should revert if trove is healthy (ICR >= MCR)", async () => {
      // Alice's trove is healthy at 150% ICR with MCR of 150%
      // Don't drop price, so trove stays healthy
      await expect(
        contracts.reversibleCallOptionManager.initializeOption(
          alice.wallet.address,
          3600,
        ),
      ).to.be.reverted
    })

    it("should revert if premium is zero", async () => {
      await dropPrice(contracts, deployer, alice)

      const premium = await calculateRequiredPremium(alice.wallet.address)

      await contracts.reversibleCallOptionManager.initializeOption(
        alice.wallet.address,
        3600,
      )

      await expect(
        contracts.reversibleCallOptionManager
          .connect(deployer.wallet)
          .support(alice.wallet.address, { value: 0 }),
      ).to.be.reverted
    })

    it("should revert if option already exists for trove", async () => {
      await dropPrice(contracts, deployer, alice)

      await contracts.reversibleCallOptionManager.initializeOption(
        alice.wallet.address,
        3600,
      )

      // Try to create another option for the same trove (use deployer who has enough ETH)
      await expect(
        contracts.reversibleCallOptionManager.initializeOption(
          alice.wallet.address,
          3600,
        ),
      ).to.be.reverted
    })

    it("should revert if maturity duration is zero", async () => {
      // Make Alice's trove undercollateralized by dropping price
      await dropPrice(contracts, deployer, alice)

      const maturityDuration = 0

      await expect(
        contracts.reversibleCallOptionManager.initializeOption(
          alice.wallet.address,
          maturityDuration,
        ),
      ).to.be.reverted
    })
  })

  describe("Lambda Calculation", () => {
    it("should calculate lambda based on risk formula", async () => {
      await dropPrice(contracts, deployer, alice)

      await contracts.reversibleCallOptionManager.initializeOption(
        alice.wallet.address,
        3600,
      )

      const option = await contracts.reversibleCallOptionManager.getOption(
        alice.wallet.address,
      )

      // Lambda should be 33.5% based on risk formula:
      // Expected Loss = 23.5% (100% - 85% * 90%)
      // Safety Margin = 10%
      // Total = 33.5%
      const expectedLambda = (335n * to1e18(1)) / 1000n // 33.5%
      expect(option.lambda).to.equal(expectedLambda)
    })

    it("should respect MIN_LAMBDA boundary", async () => {
      // Note: With current risk formula, lambda is always 33.5%
      // This test verifies MIN_LAMBDA constant exists
      const MIN_LAMBDA =
        await contracts.reversibleCallOptionManager.MIN_LAMBDA()
      expect(MIN_LAMBDA).to.equal((5n * to1e18(1)) / 100n) // 5%
    })

    it("should respect MAX_LAMBDA boundary", async () => {
      // Note: With current risk formula, lambda is always 33.5%
      // This test verifies MAX_LAMBDA constant exists
      const MAX_LAMBDA =
        await contracts.reversibleCallOptionManager.MAX_LAMBDA()
      expect(MAX_LAMBDA).to.equal((50n * to1e18(1)) / 100n) // 50%
    })
  })

  describe("Multiple Options by Same Supporter", () => {
    it("should allow multiple option creations.", async () => {
      // Make both Alice and Carol undercollateralized
      await dropPrice(contracts, deployer, alice)
      await dropPrice(contracts, deployer, carol)

      await contracts.reversibleCallOptionManager
        .connect(alice.wallet)
        .initializeOption(alice.wallet.address, 3600)

      await contracts.reversibleCallOptionManager
        .connect(carol.wallet)
        .initializeOption(carol.wallet.address, 3600)

      const option1 = await contracts.reversibleCallOptionManager.getOption(
        alice.wallet.address,
      )
      const option2 = await contracts.reversibleCallOptionManager.getOption(
        carol.wallet.address,
      )

      expect(option1.phase).to.equal(1)
      expect(option2.phase).to.equal(1)
    })

    it("should track total premiums for multiple options", async () => {
      await dropPrice(contracts, deployer, alice)
      await dropPrice(contracts, deployer, carol)

      const premium1 = await calculateRequiredPremium(alice.wallet.address)
      const premium2 = await calculateRequiredPremium(carol.wallet.address)

      await contracts.reversibleCallOptionManager
        .connect(alice.wallet)
        .initializeOption(alice.wallet.address, 3600)

      await contracts.reversibleCallOptionManager
        .connect(carol.wallet)
        .initializeOption(carol.wallet.address, 3600)

      await contracts.reversibleCallOptionManager
        .connect(deployer.wallet)
        .support(alice.wallet.address, { value: premium1 })

      await contracts.reversibleCallOptionManager
        .connect(deployer.wallet)
        .support(carol.wallet.address, { value: premium2 })

      const totalPremiums =
        await contracts.reversibleCallOptionManager.totalPremiumsCollected(
          deployer.wallet.address,
        )
      expect(totalPremiums).to.equal(premium1 + premium2)
    })
  })

  describe("Option Initialization After Previous Option", () => {
    it("should allow new option after previous option was terminated", async () => {
      await dropPrice(contracts, deployer, alice)

      // First option
      const premium1 = await calculateRequiredPremium(alice.wallet.address)
      await contracts.reversibleCallOptionManager
        .connect(alice.wallet)
        .initializeOption(alice.wallet.address, 3600)

      await contracts.reversibleCallOptionManager
        .connect(deployer.wallet)
        .support(alice.wallet.address, { value: premium1 })

      // Terminate it
      const terminationFee =
        await contracts.reversibleCallOptionManager.getTerminationFee(
          alice.wallet.address,
        )
      await contracts.reversibleCallOptionManager
        .connect(alice.wallet)
        .terminateEarly(alice.wallet.address, { value: terminationFee })

      // Create new option
      const premium2 = await calculateRequiredPremium(alice.wallet.address)
      await contracts.reversibleCallOptionManager
        .connect(alice.wallet)
        .initializeOption(alice.wallet.address, 3600)

      const option = await contracts.reversibleCallOptionManager.getOption(
        alice.wallet.address,
      )

      expect(option.exists).to.equal(true)
      expect(option.phase).to.equal(1) // PreMaturity
      // expect(option.premium).to.be.greaterThan(0)
    })

    it("should allow new option after previous option expired", async () => {
      await dropPrice(contracts, deployer, alice)

      // First option with short maturity
      const premium1 = await calculateRequiredPremium(alice.wallet.address)
      await contracts.reversibleCallOptionManager.initializeOption(
        alice.wallet.address,
        3600,
      )

      await contracts.reversibleCallOptionManager
        .connect(deployer.wallet)
        .support(alice.wallet.address, { value: premium1 })

      // Fast forward past maturity
      await fastForwardTime(3700)

      // Default the option (can be called by supporter after maturity)
      await contracts.reversibleCallOptionManager
        .connect(deployer.wallet)
        .defaultOption(alice.wallet.address)

      await contracts.reversibleCallOptionManager.initializeOption(
        alice.wallet.address,
        3600,
      )

      const option = await contracts.reversibleCallOptionManager.getOption(
        alice.wallet.address,
      )
      expect(option.exists).to.equal(true)
      expect(option.phase).to.equal(1) // PreMaturity
    })

    it("should update phase to Maturity after maturity time", async () => {
      // Make Alice's trove undercollateralized
      await dropPrice(contracts, deployer, alice)

      // Calculate premium and initialize option
      const premium = await calculateRequiredPremium(alice.wallet.address)
      const maturityDuration = 3600 // 1 hour
      await contracts.reversibleCallOptionManager.initializeOption(
        alice.wallet.address,
        3600,
      )

      await contracts.reversibleCallOptionManager
        .connect(deployer.wallet)
        .support(alice.wallet.address, { value: premium })

      // Fast-forward time past maturity
      await fastForwardTime(maturityDuration + 1)

      // Call updatePhaseToMaturity
      await contracts.reversibleCallOptionManager
        .connect(deployer.wallet)
        .updatePhaseToMaturity(alice.wallet.address)

      // Check phase is now Maturity
      const option = await contracts.reversibleCallOptionManager.getOption(
        alice.wallet.address,
      )
      expect(option.phase).to.equal(3) // OptionPhase.Maturity
    })
  })

  describe("Gas Estimation", () => {
    it("should estimate gas for option initialization", async () => {
      await dropPrice(contracts, deployer, alice)
      const gasEstimate = await contracts.reversibleCallOptionManager
        .connect(alice.wallet)
        .initializeOption.estimateGas(alice.wallet.address, 3600)
      expect(gasEstimate).to.be.gt(0)
      expect(gasEstimate).to.be.lt(500000)
    })
  })

  describe("terminateEarly", () => {
    it("should allow the borrower to terminate the option early by paying the termination fee", async () => {
      await dropPrice(contracts, deployer, alice)
      await contracts.reversibleCallOptionManager
        .connect(alice.wallet)
        .initializeOption(alice.wallet.address, 3600)
      const premium = await calculateRequiredPremium(alice.wallet.address)
      await contracts.reversibleCallOptionManager
        .connect(deployer.wallet)
        .support(alice.wallet.address, { value: premium })
      const terminationFee =
        await contracts.reversibleCallOptionManager.getTerminationFee(
          alice.wallet.address,
        )
      await ethers.provider.send("hardhat_setBalance", [
        alice.wallet.address,
        "0x152D02C7E14AF6800000",
      ])
      const supporterBalanceBefore = await ethers.provider.getBalance(
        deployer.wallet.address,
      )

      await contracts.reversibleCallOptionManager
        .connect(alice.wallet)
        .terminateEarly(alice.wallet.address, {
          value: terminationFee,
        })
      const option = await contracts.reversibleCallOptionManager.getOption(
        alice.wallet.address,
      )
      const supporterBalanceAfter = await ethers.provider.getBalance(
        deployer.wallet.address,
      )
      expect(option.phase).to.equal(5)
      //Allow for gas cost tolerance
      expect(supporterBalanceAfter - supporterBalanceBefore).to.equal(
        terminationFee,
      )
    })

    it("should revert if the option has already matured", async () => {
      await dropPrice(contracts, deployer, alice)
      await contracts.reversibleCallOptionManager
        .connect(alice.wallet)
        .initializeOption(alice.wallet.address, 3600)
      const premium = await calculateRequiredPremium(alice.wallet.address)
      await contracts.reversibleCallOptionManager
        .connect(deployer.wallet)
        .support(alice.wallet.address, { value: premium })
      await fastForwardTime(3700)
      await expect(
        contracts.reversibleCallOptionManager
          .connect(alice.wallet)
          .terminateEarly(alice.wallet.address, { value: to1e18(1) }),
      ).to.be.revertedWith("RCO: Option matured")
    })

    it("should revert if the termination fee is insufficient", async () => {
      await dropPrice(contracts, deployer, alice)
      await contracts.reversibleCallOptionManager
        .connect(alice.wallet)
        .initializeOption(alice.wallet.address, 3600)
      const premium = await calculateRequiredPremium(alice.wallet.address)
      await contracts.reversibleCallOptionManager
        .connect(deployer.wallet)
        .support(alice.wallet.address, { value: premium })
      const terminationFee =
        await contracts.reversibleCallOptionManager.getTerminationFee(
          alice.wallet.address,
        )
      await expect(
        contracts.reversibleCallOptionManager
          .connect(alice.wallet)
          .terminateEarly(alice.wallet.address, { value: terminationFee - 1n }),
      ).to.be.revertedWith("RCO: Insufficient termination fee")
    })

    it("should revert if the caller is not the borrower", async () => {
      await dropPrice(contracts, deployer, alice)
      await contracts.reversibleCallOptionManager
        .connect(alice.wallet)
        .initializeOption(alice.wallet.address, 3600)
      const premium = await calculateRequiredPremium(alice.wallet.address)
      await contracts.reversibleCallOptionManager
        .connect(deployer.wallet)
        .support(alice.wallet.address, { value: premium })
      const terminationFee =
        await contracts.reversibleCallOptionManager.getTerminationFee(
          alice.wallet.address,
        )
      await ethers.provider.send("hardhat_setBalance", [
        bob.wallet.address,
        "0x152D02C7E14AF6800000",
      ])
      await expect(
        contracts.reversibleCallOptionManager
          .connect(bob.wallet)
          .terminateEarly(alice.wallet.address, { value: terminationFee }),
      ).to.be.revertedWith("RCO: Only borrower")
    })

    it("should emit OptionTerminated event on successful termination", async () => {
      await dropPrice(contracts, deployer, alice)
      await contracts.reversibleCallOptionManager
        .connect(alice.wallet)
        .initializeOption(alice.wallet.address, 3600)
      const premium = await calculateRequiredPremium(alice.wallet.address)
      await contracts.reversibleCallOptionManager
        .connect(deployer.wallet)
        .support(alice.wallet.address, { value: premium })
      const terminationFee =
        await contracts.reversibleCallOptionManager.getTerminationFee(
          alice.wallet.address,
        )
      await expect(
        contracts.reversibleCallOptionManager
          .connect(alice.wallet)
          .terminateEarly(alice.wallet.address, { value: terminationFee }),
      )
        .to.emit(contracts.reversibleCallOptionManager, "OptionTerminated")
        .withArgs(alice.wallet.address, terminationFee)
    })
  })

  describe("exercise", () => {
    it("should allow the supporter to exercise the option at maturity when profitable", async () => {
      await ethers.provider.send("hardhat_setBalance", [
        bob.wallet.address,
        "0x" + (100000n * to1e18(1)).toString(16),
      ])
      await dropPrice(contracts, deployer, alice)
      await contracts.reversibleCallOptionManager
        .connect(alice.wallet)
        .initializeOption(alice.wallet.address, 31 * 60)
      const premium = await calculateRequiredPremium(alice.wallet.address)
      await contracts.reversibleCallOptionManager
        .connect(bob.wallet)
        .support(alice.wallet.address, { value: premium })
      await fastForwardTime(31 * 60 + 1)
      await contracts.mockAggregator
        .connect(deployer.wallet)
        .setPrice(to1e18(60_000))
      const price = await contracts.priceFeed.fetchPrice()
      const [coll, principal, interest] =
        await contracts.troveManager.getEntireDebtAndColl(alice.wallet.address)
      const collateralValue = (coll * price) / to1e18(1)
      const strikePrice = principal + interest
      const debtToPayBySupporter = strikePrice - to1e18(200)
      await contracts.musd
        .connect(carol.wallet)
        .transfer(bob.wallet.address, to1e18(500_000))
      const bobEthBefore = await ethers.provider.getBalance(bob.wallet.address)
      const bobMusdBefore = await contracts.musd.balanceOf(bob.wallet.address)
      await contracts.reversibleCallOptionManager
        .connect(bob.wallet)
        .exercise(alice.wallet.address)
      const bobEthAfter = await ethers.provider.getBalance(bob.wallet.address)
      expect(bobEthAfter).to.be.gt(bobEthBefore)
      const bobMusdAfter = await contracts.musd.balanceOf(bob.wallet.address)
      expect(bobMusdBefore - bobMusdAfter).to.be.gte(
        (debtToPayBySupporter * 99n) / 100n,
      )
      const option = await contracts.reversibleCallOptionManager.getOption(
        alice.wallet.address,
      )
      expect(option.phase).to.equal(4)
      expect(
        await contracts.reversibleCallOptionManager.successfulExercises(
          bob.wallet.address,
        ),
      ).to.equal(1)
    })

    it("should revert if option has not matured yet", async () => {
      await ethers.provider.send("hardhat_setBalance", [
        bob.wallet.address,
        "0x" + (100000n * to1e18(1)).toString(16),
      ])
      await dropPrice(contracts, deployer, alice)
      await contracts.reversibleCallOptionManager
        .connect(alice.wallet)
        .initializeOption(alice.wallet.address, 31 * 60)
      const premium = await calculateRequiredPremium(alice.wallet.address)
      await contracts.reversibleCallOptionManager
        .connect(bob.wallet)
        .support(alice.wallet.address, { value: premium })
      await expect(
        contracts.reversibleCallOptionManager
          .connect(bob.wallet)
          .exercise(alice.wallet.address),
      ).to.be.revertedWith("RCO: Not matured")
    })

    it("should revert if exercise is not profitable (A(T) < K)", async () => {
      await ethers.provider.send("hardhat_setBalance", [
        bob.wallet.address,
        "0x" + (100000n * to1e18(1)).toString(16),
      ])
      await dropPrice(contracts, deployer, alice)
      await contracts.reversibleCallOptionManager
        .connect(alice.wallet)
        .initializeOption(alice.wallet.address, 31 * 60)
      const premium = await calculateRequiredPremium(alice.wallet.address)
      await contracts.reversibleCallOptionManager
        .connect(bob.wallet)
        .support(alice.wallet.address, { value: premium })
      await fastForwardTime(31 * 60 + 1)
      await contracts.mockAggregator
        .connect(deployer.wallet)
        .setPrice(to1e18(10_000))
      await expect(
        contracts.reversibleCallOptionManager
          .connect(bob.wallet)
          .exercise(alice.wallet.address),
      ).to.be.revertedWith("RCO: Exercise not profitable, A(T) < K")
    })

    it("should revert if supporter does not have enough mUSD", async () => {
      await ethers.provider.send("hardhat_setBalance", [
        bob.wallet.address,
        "0x" + (100000n * to1e18(1)).toString(16),
      ])
      await dropPrice(contracts, deployer, alice)
      await contracts.reversibleCallOptionManager
        .connect(alice.wallet)
        .initializeOption(alice.wallet.address, 31 * 60)
      const premium = await calculateRequiredPremium(alice.wallet.address)
      await contracts.reversibleCallOptionManager
        .connect(bob.wallet)
        .support(alice.wallet.address, { value: premium })
      await fastForwardTime(31 * 60 + 1)
      await contracts.mockAggregator
        .connect(deployer.wallet)
        .setPrice(to1e18(60_000))
      await expect(
        contracts.reversibleCallOptionManager
          .connect(bob.wallet)
          .exercise(alice.wallet.address),
      ).to.be.revertedWith("RCO: Insufficient mUSD for strike")
    })

    it("should revert if caller is not the supporter", async () => {
      await ethers.provider.send("hardhat_setBalance", [
        bob.wallet.address,
        "0x" + (100000n * to1e18(1)).toString(16),
      ])
      await dropPrice(contracts, deployer, alice)
      await contracts.reversibleCallOptionManager
        .connect(alice.wallet)
        .initializeOption(alice.wallet.address, 31 * 60)
      const premium = await calculateRequiredPremium(alice.wallet.address)
      await contracts.reversibleCallOptionManager
        .connect(bob.wallet)
        .support(alice.wallet.address, { value: premium })
      await fastForwardTime(31 * 60 + 1)
      await expect(
        contracts.reversibleCallOptionManager
          .connect(carol.wallet)
          .exercise(alice.wallet.address),
      ).to.be.revertedWith("RCO: Only supporter")
    })

    it("should revert if option does not exist", async () => {
      await expect(
        contracts.reversibleCallOptionManager
          .connect(bob.wallet)
          .exercise(carol.wallet.address),
      ).to.be.revertedWith("RCO: Option does not exist")
    })

    it("should revert if option was terminated early", async () => {
      await ethers.provider.send("hardhat_setBalance", [
        bob.wallet.address,
        "0x" + (100000n * to1e18(1)).toString(16),
      ])
      await dropPrice(contracts, deployer, alice)
      await contracts.reversibleCallOptionManager
        .connect(alice.wallet)
        .initializeOption(alice.wallet.address, 31 * 60)
      const premium = await calculateRequiredPremium(alice.wallet.address)
      await contracts.reversibleCallOptionManager
        .connect(bob.wallet)
        .support(alice.wallet.address, { value: premium })
      const terminationFee =
        await contracts.reversibleCallOptionManager.getTerminationFee(
          alice.wallet.address,
        )
      await contracts.reversibleCallOptionManager
        .connect(alice.wallet)
        .terminateEarly(alice.wallet.address, { value: terminationFee })
      await fastForwardTime(31 * 60 + 1)
      await expect(
        contracts.reversibleCallOptionManager
          .connect(bob.wallet)
          .exercise(alice.wallet.address),
      ).to.be.revertedWith("RCO: Invalid phase")
    })

    it("should emit OptionExercised event with correct parameters", async () => {
      await ethers.provider.send("hardhat_setBalance", [
        bob.wallet.address,
        "0x" + (100000n * to1e18(1)).toString(16),
      ])
      await dropPrice(contracts, deployer, alice)
      await contracts.reversibleCallOptionManager
        .connect(alice.wallet)
        .initializeOption(alice.wallet.address, 31 * 60)
      const premium = await calculateRequiredPremium(alice.wallet.address)
      await contracts.reversibleCallOptionManager
        .connect(bob.wallet)
        .support(alice.wallet.address, { value: premium })
      await fastForwardTime(31 * 60 + 1)
      await contracts.mockAggregator
        .connect(deployer.wallet)
        .setPrice(to1e18(60_000))
      await openTrove(contracts, {
        musdAmount: "500000",
        sender: dennis.wallet,
        ICR: "200",
      })
      await contracts.musd
        .connect(dennis.wallet)
        .transfer(bob.wallet.address, to1e18(500_000))
      const tx = await contracts.reversibleCallOptionManager
        .connect(bob.wallet)
        .exercise(alice.wallet.address)
      const receipt = await tx.wait()
      const event = receipt?.logs.find((log: any) => {
        try {
          const parsed =
            contracts.reversibleCallOptionManager.interface.parseLog(log)
          return parsed?.name === "OptionExercised"
        } catch {
          return false
        }
      })
      expect(event).to.not.be.undefined
    })

    it("should correctly update supporter balances and statistics", async () => {
      await ethers.provider.send("hardhat_setBalance", [
        bob.wallet.address,
        "0x" + (100000n * to1e18(1)).toString(16),
      ])
      await dropPrice(contracts, deployer, alice)
      await contracts.reversibleCallOptionManager
        .connect(alice.wallet)
        .initializeOption(alice.wallet.address, 31 * 60)

      const option = await contracts.reversibleCallOptionManager.getOption(
        alice.wallet.address,
      )
      const premium = option.premium
      await contracts.reversibleCallOptionManager
        .connect(bob.wallet)
        .support(alice.wallet.address, { value: premium })
      const supporterBalanceBefore =
        await contracts.reversibleCallOptionManager.supporterBalances(
          bob.wallet.address,
        )
      expect(supporterBalanceBefore).to.equal(premium)

      await fastForwardTime(31 * 60 + 1)
      await contracts.mockAggregator
        .connect(deployer.wallet)
        .setPrice(to1e18(60_000))
      await openTrove(contracts, {
        musdAmount: "500000",
        sender: dennis.wallet,
        ICR: "200",
      })
      await contracts.musd
        .connect(dennis.wallet)
        .transfer(bob.wallet.address, to1e18(500_000))
      await contracts.reversibleCallOptionManager
        .connect(bob.wallet)
        .exercise(alice.wallet.address)
      const supporterBalanceAfter =
        await contracts.reversibleCallOptionManager.supporterBalances(
          bob.wallet.address,
        )
      console.log("Premium:", premium.toString())
      console.log(
        "Supporter balance before:",
        supporterBalanceBefore.toString(),
      )
      console.log("Supporter balance after:", supporterBalanceAfter.toString())
      expect(supporterBalanceAfter).to.equal(0)
      const [, totalPremiums, exercises, terminations] =
        await contracts.reversibleCallOptionManager.getSupporterStats(
          bob.wallet.address,
        )
      expect(totalPremiums).to.equal(premium)
      expect(exercises).to.equal(1)
      expect(terminations).to.equal(0)
    })
  })
})

// SPDX-License-Identifier: MIT

pragma solidity 0.8.24;

interface IReversibleCallOptionManager {
    // ============ Enums ============

    enum OptionPhase {
        None,
        Initialization,
        PreMaturity,
        Maturity,
        Exercised,
        Terminated,
        Defaulted
    }

    // ============ Structs ============

    struct BackstopOption {
        address borrower;
        address supporter;
        uint256 collateralAtStart;
        uint256 debtAtStart;
        uint256 lambda;
        uint256 premium;
        uint256 strikeCR;
        uint256 startTime;
        uint256 maturityTime;
        uint256 interestRate;
        OptionPhase phase;
        bool exists;
    }

    // ============ Events ============

    event OptionInitialized(
        address indexed borrower,
        uint256 lambda,
        uint256 premium,
        uint256 strikeCR,
        uint256 maturityTime
    );

    event OptionSupported(
        address indexed borrower,
        address indexed supporter,
        uint256 premiumPaid,
        uint256 strikeCR,
        uint256 maturityTime
    );

    event OptionExercised(
        address indexed borrower,
        address indexed supporter,
        uint256 collateralValue,
        uint256 debtValue,
        uint256 profit
    );

    event OptionTerminated(address indexed borrower, uint256 terminationFee);

    event OptionDefaulted(
        address indexed borrower,
        address indexed supporter,
        uint256 premiumLost
    );

    // ============ Core Functions ============

    function initializeOption(
        address _borrower,
        uint256 _maturityDuration
    ) external;

    function support(
        address _borrower,
        address _upperHint,
        address _lowerHint
    ) external payable;

    function terminateEarly(address _borrower) external payable;

    function exercise(address _borrower) external;

    function defaultOption(address _borrower) external;

    function notifyTroveLiquidated(address _borrower) external;

    // ============ View Functions ============

    function isOptionActive(address _borrower) external view returns (bool);

    function getOption(
        address _borrower
    ) external view returns (BackstopOption memory);

    function getOptionPhase(
        address _borrower
    ) external view returns (OptionPhase);

    function getTerminationFee(
        address _borrower
    ) external view returns (uint256);

    // function updatePhaseToMaturity(address _borrower) external;

    function getSupporterStats(
        address _supporter
    )
        external
        view
        returns (
            uint256 balance,
            uint256 totalPremiums,
            uint256 exercises,
            uint256 terminations
        );
}

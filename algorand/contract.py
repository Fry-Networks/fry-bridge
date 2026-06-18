"""
Fry Bridge Algorand — PyTeal Router (ARC-4)
Lock-and-mint bridge contract for Solana ↔ Algorand interoperability.
"""
from pyteal import *
from pyteal.ast.router import Router

# ── Constants ──────────────────────────────────────────────────────
HOUR_SECONDS = Int(3600)
DAY_SECONDS = Int(86400)
RECORD_SIZE = Int(105)  # 32 + 32 + 8*5 + 1


# ── Helpers ──────────────────────────────────────────────────────────
def assert_authority():
    return Assert(
        Txn.sender() == App.globalGet(Bytes("authority")),
        comment="Unauthorized",
    )


def assert_relayer():
    return Assert(
        Txn.sender() == App.globalGet(Bytes("relayer")),
        comment="Unauthorized",
    )


def assert_not_paused():
    return Assert(
        App.globalGet(Bytes("paused")) == Int(0),
        comment="Paused",
    )


def check_rate_limits(amount: Expr) -> Expr:
    now = Global.latest_timestamp()
    per_tx_limit = App.globalGet(Bytes("per_tx_limit"))
    hourly_period_start = App.globalGet(Bytes("hourly_period_start"))
    hourly_volume = App.globalGet(Bytes("hourly_volume"))
    hourly_limit = App.globalGet(Bytes("hourly_limit"))
    daily_period_start = App.globalGet(Bytes("daily_period_start"))
    daily_volume = App.globalGet(Bytes("daily_volume"))
    daily_limit = App.globalGet(Bytes("daily_limit"))

    return Seq([
        # per-tx cap
        Assert(amount <= per_tx_limit, comment="RateLimitExceeded"),

        # hourly bucket
        If(now - hourly_period_start >= HOUR_SECONDS).Then(
            Seq([
                App.globalPut(Bytes("hourly_period_start"), now),
                App.globalPut(Bytes("hourly_volume"), Int(0)),
            ])
        ),
        App.globalPut(Bytes("hourly_volume"), hourly_volume + amount),
        Assert(App.globalGet(Bytes("hourly_volume")) <= hourly_limit, comment="RateLimitExceeded"),

        # daily bucket
        If(now - daily_period_start >= DAY_SECONDS).Then(
            Seq([
                App.globalPut(Bytes("daily_period_start"), now),
                App.globalPut(Bytes("daily_volume"), Int(0)),
            ])
        ),
        App.globalPut(Bytes("daily_volume"), daily_volume + amount),
        Assert(App.globalGet(Bytes("daily_volume")) <= daily_limit, comment="RateLimitExceeded"),
    ])


def compute_time_lock(amount: Expr) -> Expr:
    threshold = App.globalGet(Bytes("time_lock_threshold"))
    duration = App.globalGet(Bytes("time_lock_duration"))
    now = Global.latest_timestamp()
    return If(amount >= threshold, now + duration, Int(0))


def lock_record_key(user_addr: Expr, nonce: Expr) -> Expr:
    return Concat(user_addr, Itob(nonce))


# ── Router ───────────────────────────────────────────────────────────
router = Router(
    "fry_bridge_algorand",
    BareCallActions(
        no_op=OnCompleteAction.call_only(
            Seq([
                App.globalPut(Bytes("authority"), Txn.sender()),
                App.globalPut(Bytes("relayer"), Txn.sender()),
                App.globalPut(Bytes("paused"), Int(1)),          # start paused
                App.globalPut(Bytes("nonce"), Int(0)),
                App.globalPut(Bytes("fsol_asa_id"), Int(0)),
                App.globalPut(Bytes("per_tx_limit"), Int(0)),
                App.globalPut(Bytes("hourly_limit"), Int(0)),
                App.globalPut(Bytes("daily_limit"), Int(0)),
                App.globalPut(Bytes("time_lock_threshold"), Int(0)),
                App.globalPut(Bytes("time_lock_duration"), Int(0)),
                App.globalPut(Bytes("hourly_volume"), Int(0)),
                App.globalPut(Bytes("hourly_period_start"), Int(0)),
                App.globalPut(Bytes("daily_volume"), Int(0)),
                App.globalPut(Bytes("daily_period_start"), Int(0)),
                Approve(),
            ])
        ),
    ),
    clear_state=Approve(),
)


# ── Methods ─────────────────────────────────────────────────────────

@router.method
def initialize(
    relayer: abi.Address,
    fsol_asa_id: abi.Uint64,
):
    """Initialize bridge state. Callable once by authority."""
    r = relayer.get()
    fsol = fsol_asa_id.get()
    now = Global.latest_timestamp()

    return Seq([
        assert_authority(),
        Assert(App.globalGet(Bytes("fsol_asa_id")) == Int(0), comment="AlreadyInitialized"),
        App.globalPut(Bytes("relayer"), r),
        App.globalPut(Bytes("fsol_asa_id"), fsol),
        App.globalPut(Bytes("hourly_volume"), Int(0)),
        App.globalPut(Bytes("hourly_period_start"), now),
        App.globalPut(Bytes("daily_volume"), Int(0)),
        App.globalPut(Bytes("daily_period_start"), now),
        App.globalPut(Bytes("paused"), Int(0)),
        Approve(),
    ])


@router.method
def set_limits(
    per_tx_limit: abi.Uint64,
    hourly_limit: abi.Uint64,
    daily_limit: abi.Uint64,
    time_lock_threshold: abi.Uint64,
    time_lock_duration: abi.Uint64,
):
    """Set rate limits and time-lock params. Authority only."""
    ptl = per_tx_limit.get()
    hl = hourly_limit.get()
    dl = daily_limit.get()
    tlt = time_lock_threshold.get()
    tld = time_lock_duration.get()

    return Seq([
        assert_authority(),
        App.globalPut(Bytes("per_tx_limit"), ptl),
        App.globalPut(Bytes("hourly_limit"), hl),
        App.globalPut(Bytes("daily_limit"), dl),
        App.globalPut(Bytes("time_lock_threshold"), tlt),
        App.globalPut(Bytes("time_lock_duration"), tld),
        Approve(),
    ])


@router.method
def set_relayer(new_relayer: abi.Address):
    """Change relayer address. Authority only."""
    return Seq([
        assert_authority(),
        App.globalPut(Bytes("relayer"), new_relayer.get()),
        Approve(),
    ])


@router.method
def pause():
    """Pause bridge operations. Authority only."""
    return Seq([
        assert_authority(),
        App.globalPut(Bytes("paused"), Int(1)),
        Approve(),
    ])


@router.method
def unpause():
    """Unpause bridge operations. Authority only."""
    return Seq([
        assert_authority(),
        App.globalPut(Bytes("paused"), Int(0)),
        Approve(),
    ])


@router.method
def deposit_asa(
    asa_id: abi.Uint64,
    nonce: abi.Uint64,
    amount: abi.Uint64,
    solana_recipient: abi.Address,
):
    """Deposit ASA and create a lock record."""
    a = asa_id.get()
    n = nonce.get()
    amt = amount.get()
    sr = solana_recipient.get()
    prev_idx = Txn.group_index() - Int(1)
    deposit_txn = Gtxn[prev_idx]

    key = lock_record_key(Txn.sender(), n)
    time_locked = compute_time_lock(amt)
    record = Concat(
        Txn.sender(),                    # user   (32 bytes)
        sr,                              # solana_recipient (32 bytes)
        Itob(amt),                       # amount (8 bytes)
        Itob(a),                         # token  (8 bytes)
        Itob(n),                         # nonce  (8 bytes)
        Itob(Global.latest_timestamp()), # ts     (8 bytes)
        Itob(time_locked),               # lock   (8 bytes)
        Bytes("base16", "0x00"),         # consumed (1 byte)
    )

    return Seq([
        assert_not_paused(),
        check_rate_limits(amt),

        # Verify grouped asset transfer
        Assert(deposit_txn.type_enum() == TxnType.AssetTransfer, comment="InvalidDepositTxn"),
        Assert(deposit_txn.xfer_asset() == a, comment="InvalidTokenPair"),
        Assert(deposit_txn.asset_receiver() == Global.current_application_address(), comment="InvalidDepositReceiver"),
        Assert(deposit_txn.asset_amount() == amt, comment="InvalidDepositAmount"),
        Assert(deposit_txn.sender() == Txn.sender(), comment="InvalidDepositSender"),

        # Prevent duplicate nonce
        Assert(App.box_create(key, RECORD_SIZE) > Int(0), comment="InvalidNonce"),
        App.box_put(key, record),
        Approve(),
    ])


@router.method
def burn_fsol(
    nonce: abi.Uint64,
    amount: abi.Uint64,
    solana_recipient: abi.Address,
):
    """Burn fSOL and create a lock record."""
    n = nonce.get()
    amt = amount.get()
    sr = solana_recipient.get()
    fsol = App.globalGet(Bytes("fsol_asa_id"))
    prev_idx = Txn.group_index() - Int(1)
    deposit_txn = Gtxn[prev_idx]

    key = lock_record_key(Txn.sender(), n)
    time_locked = compute_time_lock(amt)
    record = Concat(
        Txn.sender(),
        sr,
        Itob(amt),
        Itob(fsol),
        Itob(n),
        Itob(Global.latest_timestamp()),
        Itob(time_locked),
        Bytes("base16", "0x00"),
    )

    return Seq([
        assert_not_paused(),

        # Verify grouped fSOL transfer
        Assert(deposit_txn.type_enum() == TxnType.AssetTransfer, comment="InvalidDepositTxn"),
        Assert(deposit_txn.xfer_asset() == fsol, comment="InvalidTokenPair"),
        Assert(deposit_txn.asset_receiver() == Global.current_application_address(), comment="InvalidDepositReceiver"),
        Assert(deposit_txn.asset_amount() == amt, comment="InvalidDepositAmount"),
        Assert(deposit_txn.sender() == Txn.sender(), comment="InvalidDepositSender"),

        # Prevent duplicate nonce
        Assert(App.box_create(key, RECORD_SIZE) > Int(0), comment="InvalidNonce"),
        App.box_put(key, record),
        Approve(),
    ])


@router.method
def mint_fsol(
    recipient: abi.Address,
    nonce: abi.Uint64,
    amount: abi.Uint64,
):
    """Relayer mints fSOL to recipient."""
    r = recipient.get()
    n = nonce.get()
    amt = amount.get()
    fsol = App.globalGet(Bytes("fsol_asa_id"))

    key = lock_record_key(r, n)
    record = Concat(
        r,
        Itob(amt),
        Itob(fsol),
        Itob(n),
        Itob(Global.latest_timestamp()),
        Itob(Int(0)),                    # no time lock for mint
        Bytes("base16", "0x00"),
    )

    return Seq([
        assert_relayer(),
        assert_not_paused(),

        # Prevent duplicate nonce
        Assert(App.box_create(key, RECORD_SIZE) > Int(0), comment="InvalidNonce"),
        App.box_put(key, record),

        # Inner txn: transfer fSOL from reserve (contract itself) to recipient
        InnerTxnBuilder.Begin(),
        InnerTxnBuilder.SetFields({
            TxnField.type_enum: TxnType.AssetTransfer,
            TxnField.sender: Global.current_application_address(),
            TxnField.asset_receiver: r,
            TxnField.asset_amount: amt,
            TxnField.xfer_asset: fsol,
            TxnField.fee: Int(0),
        }),
        InnerTxnBuilder.Submit(),
        Approve(),
    ])


@router.method
def release_asa(
    recipient: abi.Address,
    asa_id: abi.Uint64,
    nonce: abi.Uint64,
    amount: abi.Uint64,
):
    """Relayer releases ASA to recipient."""
    r = recipient.get()
    a = asa_id.get()
    n = nonce.get()
    amt = amount.get()

    key = lock_record_key(r, n)
    record = Concat(
        r,
        Itob(amt),
        Itob(a),
        Itob(n),
        Itob(Global.latest_timestamp()),
        Itob(Int(0)),
        Bytes("base16", "0x00"),
    )

    return Seq([
        assert_relayer(),
        assert_not_paused(),

        # Prevent duplicate nonce
        Assert(App.box_create(key, RECORD_SIZE) > Int(0), comment="InvalidNonce"),
        App.box_put(key, record),

        # Inner txn: transfer ASA from contract to recipient
        InnerTxnBuilder.Begin(),
        InnerTxnBuilder.SetFields({
            TxnField.type_enum: TxnType.AssetTransfer,
            TxnField.sender: Global.current_application_address(),
            TxnField.asset_receiver: r,
            TxnField.asset_amount: amt,
            TxnField.xfer_asset: a,
            TxnField.fee: Int(0),
        }),
        InnerTxnBuilder.Submit(),
        Approve(),
    ])


# ── Compilation entry point ──────────────────────────────────────────
if __name__ == "__main__":
    import json
    import sys

    approval, clear, contract = router.compile_program(
        version=9,
        optimize=OptimizeOptions(scratch_slots=True),
    )
    with open("approval.teal", "w") as f:
        f.write(approval)
    with open("clear.teal", "w") as f:
        f.write(clear)
    with open("contract.json", "w") as f:
        json.dump(contract.dictify(), f, indent=2)
    print("Compiled: approval.teal, clear.teal, contract.json", file=sys.stderr)

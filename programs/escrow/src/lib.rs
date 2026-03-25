use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("5xdcfLVGm56Fd8twF4L1vqrqsnSj2QybNF5rbRJTbfri");

// ── Constants ──────────────────────────────────────────────────────────────

pub const MAX_ORDER_ID_LEN: usize = 64;
pub const MAX_TRACKING_LEN: usize = 64;
pub const MAX_CARRIER_LEN: usize = 32;
pub const MAX_DISPUTE_REASON_LEN: usize = 256;

/// Discriminator (8) + all fields computed below
pub const ESCROW_ACCOUNT_SIZE: usize = 8  // discriminator
    + 4 + MAX_ORDER_ID_LEN                // String: order_id
    + 32                                   // buyer: Pubkey
    + 32                                   // seller: Pubkey
    + 8                                    // amount: u64
    + 8                                    // seller_bond: u64
    + 2                                    // platform_fee_bps: u16
    + 1                                    // tier: u8
    + 1                                    // status: enum (1 byte)
    + 4 + MAX_TRACKING_LEN                 // String: tracking_number
    + 4 + MAX_CARRIER_LEN                  // String: carrier
    + 8                                    // created_at: i64
    + 8                                    // shipped_at: i64
    + 8                                    // delivered_at: i64
    + 2                                    // dispute_window_hours: u16
    + 4 + MAX_DISPUTE_REASON_LEN           // String: dispute_reason
    + 32                                   // platform_authority: Pubkey
    + 32                                   // token_mint: Pubkey
    + 1                                    // bump: u8
    + 1                                    // vault_bump: u8
    + 1                                    // bond_vault_bump: u8
    + 64;                                  // padding for future fields

// ── State ──────────────────────────────────────────────────────────────────

#[account]
pub struct EscrowAccount {
    pub order_id: String,
    pub buyer: Pubkey,
    pub seller: Pubkey,
    pub amount: u64,
    pub seller_bond: u64,
    pub platform_fee_bps: u16,
    pub tier: u8,
    pub status: EscrowStatus,
    pub tracking_number: String,
    pub carrier: String,
    pub created_at: i64,
    pub shipped_at: i64,
    pub delivered_at: i64,
    pub dispute_window_hours: u16,
    pub dispute_reason: String,
    pub platform_authority: Pubkey,
    pub token_mint: Pubkey,
    pub bump: u8,
    pub vault_bump: u8,
    pub bond_vault_bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum EscrowStatus {
    Created,
    BondDeposited,
    Shipped,
    Delivered,
    Completed,
    Disputed,
    Resolved,
    Cancelled,
    Refunded,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum DisputeResolution {
    BuyerWins,
    SellerWins,
    Split,
}

// ── Events ─────────────────────────────────────────────────────────────────

#[event]
pub struct EscrowCreated {
    pub order_id: String,
    pub buyer: Pubkey,
    pub seller: Pubkey,
    pub amount: u64,
    pub tier: u8,
    pub dispute_window_hours: u16,
}

#[event]
pub struct SellerBondDeposited {
    pub order_id: String,
    pub seller: Pubkey,
    pub bond_amount: u64,
}

#[event]
pub struct OrderShipped {
    pub order_id: String,
    pub tracking_number: String,
    pub carrier: String,
    pub shipped_at: i64,
}

#[event]
pub struct DeliveryConfirmed {
    pub order_id: String,
    pub delivered_at: i64,
}

#[event]
pub struct EscrowReleased {
    pub order_id: String,
    pub seller: Pubkey,
    pub amount: u64,
    pub platform_fee: u64,
}

#[event]
pub struct DisputeOpened {
    pub order_id: String,
    pub buyer: Pubkey,
    pub reason: String,
}

#[event]
pub struct DisputeResolved {
    pub order_id: String,
    pub resolution: DisputeResolution,
    pub buyer_amount: u64,
    pub seller_amount: u64,
}

#[event]
pub struct EscrowCancelled {
    pub order_id: String,
    pub refund_amount: u64,
}

// ── Error Codes ────────────────────────────────────────────────────────────

#[error_code]
pub enum EscrowError {
    #[msg("Order ID exceeds maximum length")]
    OrderIdTooLong,
    #[msg("Tracking number exceeds maximum length")]
    TrackingNumberTooLong,
    #[msg("Carrier name exceeds maximum length")]
    CarrierTooLong,
    #[msg("Dispute reason exceeds maximum length")]
    DisputeReasonTooLong,
    #[msg("Invalid tier: must be 1-4")]
    InvalidTier,
    #[msg("Invalid escrow status for this operation")]
    InvalidStatus,
    #[msg("Unauthorized: you are not allowed to perform this action")]
    Unauthorized,
    #[msg("Seller bond required for tier 3+")]
    SellerBondRequired,
    #[msg("Dispute window has not expired")]
    DisputeWindowActive,
    #[msg("Dispute window has expired")]
    DisputeWindowExpired,
    #[msg("Invalid amounts: buyer + seller amounts must equal total")]
    InvalidSplitAmounts,
    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,
    #[msg("Escrow amount must be greater than zero")]
    ZeroAmount,
    #[msg("Platform fee cannot exceed 10000 basis points")]
    InvalidPlatformFee,
}

// ── Program ────────────────────────────────────────────────────────────────

#[program]
pub mod escrow {
    use super::*;

    /// Buyer creates escrow and deposits USDC to vault PDA.
    pub fn create_escrow(
        ctx: Context<CreateEscrow>,
        order_id: String,
        amount: u64,
        tier: u8,
        dispute_window_hours: u16,
        platform_fee_bps: u16,
        seller_bond_amount: u64,
    ) -> Result<()> {
        require!(order_id.len() <= MAX_ORDER_ID_LEN, EscrowError::OrderIdTooLong);
        require!(tier >= 1 && tier <= 4, EscrowError::InvalidTier);
        require!(amount > 0, EscrowError::ZeroAmount);
        require!(platform_fee_bps <= 10000, EscrowError::InvalidPlatformFee);

        // Tier 3+ requires a seller bond
        if tier >= 3 {
            require!(seller_bond_amount > 0, EscrowError::SellerBondRequired);
        }

        let escrow = &mut ctx.accounts.escrow;
        escrow.order_id = order_id.clone();
        escrow.buyer = ctx.accounts.buyer.key();
        escrow.seller = ctx.accounts.seller.key();
        escrow.amount = amount;
        escrow.seller_bond = seller_bond_amount;
        escrow.platform_fee_bps = platform_fee_bps;
        escrow.tier = tier;
        escrow.status = EscrowStatus::Created;
        escrow.tracking_number = String::new();
        escrow.carrier = String::new();
        escrow.created_at = Clock::get()?.unix_timestamp;
        escrow.shipped_at = 0;
        escrow.delivered_at = 0;
        escrow.dispute_window_hours = dispute_window_hours;
        escrow.dispute_reason = String::new();
        escrow.platform_authority = ctx.accounts.platform_authority.key();
        escrow.token_mint = ctx.accounts.token_mint.key();
        escrow.bump = ctx.bumps.escrow;
        escrow.vault_bump = ctx.bumps.vault;
        escrow.bond_vault_bump = 0; // set when bond vault is created

        // Transfer USDC from buyer to vault
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.buyer_token_account.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.buyer.to_account_info(),
                },
            ),
            amount,
        )?;

        emit!(EscrowCreated {
            order_id,
            buyer: ctx.accounts.buyer.key(),
            seller: ctx.accounts.seller.key(),
            amount,
            tier,
            dispute_window_hours,
        });

        Ok(())
    }

    /// Seller deposits security bond (Tier 3+ only).
    pub fn deposit_seller_bond(ctx: Context<DepositSellerBond>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;

        require!(
            escrow.status == EscrowStatus::Created,
            EscrowError::InvalidStatus
        );
        require!(escrow.tier >= 3, EscrowError::SellerBondRequired);
        require!(
            ctx.accounts.seller.key() == escrow.seller,
            EscrowError::Unauthorized
        );

        let bond_amount = escrow.seller_bond;
        require!(bond_amount > 0, EscrowError::SellerBondRequired);

        // Transfer seller's bond to bond vault
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.seller_token_account.to_account_info(),
                    to: ctx.accounts.bond_vault.to_account_info(),
                    authority: ctx.accounts.seller.to_account_info(),
                },
            ),
            bond_amount,
        )?;

        escrow.status = EscrowStatus::BondDeposited;
        escrow.bond_vault_bump = ctx.bumps.bond_vault;

        emit!(SellerBondDeposited {
            order_id: escrow.order_id.clone(),
            seller: ctx.accounts.seller.key(),
            bond_amount,
        });

        Ok(())
    }

    /// Seller marks order as shipped with tracking info.
    pub fn mark_shipped(
        ctx: Context<MarkShipped>,
        tracking_number: String,
        carrier: String,
    ) -> Result<()> {
        require!(
            tracking_number.len() <= MAX_TRACKING_LEN,
            EscrowError::TrackingNumberTooLong
        );
        require!(carrier.len() <= MAX_CARRIER_LEN, EscrowError::CarrierTooLong);

        let escrow = &mut ctx.accounts.escrow;

        require!(
            ctx.accounts.seller.key() == escrow.seller,
            EscrowError::Unauthorized
        );

        // Allow shipping from Created (tiers 1-2) or BondDeposited (tiers 3+)
        let valid_status = escrow.status == EscrowStatus::Created
            || escrow.status == EscrowStatus::BondDeposited;
        require!(valid_status, EscrowError::InvalidStatus);

        // For tier 3+, bond must be deposited before shipping
        if escrow.tier >= 3 {
            require!(
                escrow.status == EscrowStatus::BondDeposited,
                EscrowError::InvalidStatus
            );
        }

        let now = Clock::get()?.unix_timestamp;
        escrow.tracking_number = tracking_number.clone();
        escrow.carrier = carrier.clone();
        escrow.shipped_at = now;
        escrow.status = EscrowStatus::Shipped;

        emit!(OrderShipped {
            order_id: escrow.order_id.clone(),
            tracking_number,
            carrier,
            shipped_at: now,
        });

        Ok(())
    }

    /// Platform oracle marks delivery confirmed.
    pub fn mark_delivered(ctx: Context<MarkDelivered>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;

        require!(
            ctx.accounts.platform_authority.key() == escrow.platform_authority,
            EscrowError::Unauthorized
        );
        require!(
            escrow.status == EscrowStatus::Shipped,
            EscrowError::InvalidStatus
        );

        let now = Clock::get()?.unix_timestamp;
        escrow.delivered_at = now;
        escrow.status = EscrowStatus::Delivered;

        emit!(DeliveryConfirmed {
            order_id: escrow.order_id.clone(),
            delivered_at: now,
        });

        Ok(())
    }

    /// Release escrow funds to seller.
    /// Can be called by buyer (any time after shipped) or platform authority
    /// (after dispute window expires with no dispute).
    pub fn release_escrow(ctx: Context<ReleaseEscrow>) -> Result<()> {
        let escrow = &ctx.accounts.escrow;

        let caller = ctx.accounts.caller.key();
        let is_buyer = caller == escrow.buyer;
        let is_platform = caller == escrow.platform_authority;

        require!(is_buyer || is_platform, EscrowError::Unauthorized);

        // Buyer can release after shipped, delivered, or bond deposited
        if is_buyer {
            let valid = escrow.status == EscrowStatus::Shipped
                || escrow.status == EscrowStatus::Delivered
                || escrow.status == EscrowStatus::BondDeposited;
            require!(valid, EscrowError::InvalidStatus);
        }

        // Platform can release after dispute window expires (status = Delivered)
        if is_platform {
            require!(
                escrow.status == EscrowStatus::Delivered,
                EscrowError::InvalidStatus
            );

            let now = Clock::get()?.unix_timestamp;
            let dispute_window_secs =
                (escrow.dispute_window_hours as i64) * 3600;
            let window_expires = escrow
                .delivered_at
                .checked_add(dispute_window_secs)
                .ok_or(EscrowError::ArithmeticOverflow)?;

            require!(now >= window_expires, EscrowError::DisputeWindowActive);
        }

        // Calculate platform fee
        let platform_fee = (escrow.amount as u128)
            .checked_mul(escrow.platform_fee_bps as u128)
            .ok_or(EscrowError::ArithmeticOverflow)?
            .checked_div(10000)
            .ok_or(EscrowError::ArithmeticOverflow)? as u64;

        let seller_amount = escrow
            .amount
            .checked_sub(platform_fee)
            .ok_or(EscrowError::ArithmeticOverflow)?;

        let order_id = escrow.order_id.clone();
        let escrow_bump = escrow.bump;
        let _amount = escrow.amount;
        let seller_bond = escrow.seller_bond;
        let seller_key = escrow.seller;

        // Transfer seller's portion from vault
        let seeds = &[
            b"escrow".as_ref(),
            order_id.as_bytes(),
            &[escrow_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        // Transfer seller amount from vault to seller
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.seller_token_account.to_account_info(),
                    authority: ctx.accounts.escrow.to_account_info(),
                },
                signer_seeds,
            ),
            seller_amount,
        )?;

        // Transfer platform fee from vault to platform
        if platform_fee > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.platform_token_account.to_account_info(),
                        authority: ctx.accounts.escrow.to_account_info(),
                    },
                    signer_seeds,
                ),
                platform_fee,
            )?;
        }

        // Return seller bond if applicable
        if seller_bond > 0 {
            if let Some(bond_vault) = &ctx.accounts.bond_vault {
                if let Some(seller_ta) = &ctx.accounts.seller_token_account_for_bond {
                    token::transfer(
                        CpiContext::new_with_signer(
                            ctx.accounts.token_program.to_account_info(),
                            Transfer {
                                from: bond_vault.to_account_info(),
                                to: seller_ta.to_account_info(),
                                authority: ctx.accounts.escrow.to_account_info(),
                            },
                            signer_seeds,
                        ),
                        seller_bond,
                    )?;
                }
            }
        }

        // Update status
        let escrow = &mut ctx.accounts.escrow;
        escrow.status = EscrowStatus::Completed;

        emit!(EscrowReleased {
            order_id: escrow.order_id.clone(),
            seller: seller_key,
            amount: seller_amount,
            platform_fee,
        });

        Ok(())
    }

    /// Buyer opens a dispute within the dispute window.
    pub fn open_dispute(ctx: Context<OpenDispute>, reason: String) -> Result<()> {
        require!(
            reason.len() <= MAX_DISPUTE_REASON_LEN,
            EscrowError::DisputeReasonTooLong
        );

        let escrow = &mut ctx.accounts.escrow;

        require!(
            ctx.accounts.buyer.key() == escrow.buyer,
            EscrowError::Unauthorized
        );

        // Must be in Delivered status to dispute (within dispute window)
        require!(
            escrow.status == EscrowStatus::Delivered,
            EscrowError::InvalidStatus
        );

        // Check dispute window hasn't expired
        let now = Clock::get()?.unix_timestamp;
        let dispute_window_secs = (escrow.dispute_window_hours as i64) * 3600;
        let window_expires = escrow
            .delivered_at
            .checked_add(dispute_window_secs)
            .ok_or(EscrowError::ArithmeticOverflow)?;

        require!(now < window_expires, EscrowError::DisputeWindowExpired);

        escrow.dispute_reason = reason.clone();
        escrow.status = EscrowStatus::Disputed;

        emit!(DisputeOpened {
            order_id: escrow.order_id.clone(),
            buyer: ctx.accounts.buyer.key(),
            reason,
        });

        Ok(())
    }

    /// Platform resolves a dispute.
    pub fn resolve_dispute(
        ctx: Context<ResolveDispute>,
        resolution: DisputeResolution,
        buyer_amount: u64,
        seller_amount: u64,
    ) -> Result<()> {
        let escrow = &ctx.accounts.escrow;

        require!(
            ctx.accounts.platform_authority.key() == escrow.platform_authority,
            EscrowError::Unauthorized
        );
        require!(
            escrow.status == EscrowStatus::Disputed,
            EscrowError::InvalidStatus
        );

        // Validate amounts sum to escrow total
        let total = buyer_amount
            .checked_add(seller_amount)
            .ok_or(EscrowError::ArithmeticOverflow)?;
        require!(total == escrow.amount, EscrowError::InvalidSplitAmounts);

        let order_id = escrow.order_id.clone();
        let escrow_bump = escrow.bump;
        let seller_bond = escrow.seller_bond;

        let seeds = &[
            b"escrow".as_ref(),
            order_id.as_bytes(),
            &[escrow_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        // Send buyer's portion
        if buyer_amount > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.buyer_token_account.to_account_info(),
                        authority: ctx.accounts.escrow.to_account_info(),
                    },
                    signer_seeds,
                ),
                buyer_amount,
            )?;
        }

        // Send seller's portion
        if seller_amount > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.seller_token_account.to_account_info(),
                        authority: ctx.accounts.escrow.to_account_info(),
                    },
                    signer_seeds,
                ),
                seller_amount,
            )?;
        }

        // Handle seller bond
        if seller_bond > 0 {
            if let Some(bond_vault) = &ctx.accounts.bond_vault {
                match resolution {
                    DisputeResolution::BuyerWins => {
                        // Seller loses bond — send to buyer
                        token::transfer(
                            CpiContext::new_with_signer(
                                ctx.accounts.token_program.to_account_info(),
                                Transfer {
                                    from: bond_vault.to_account_info(),
                                    to: ctx.accounts.buyer_token_account.to_account_info(),
                                    authority: ctx.accounts.escrow.to_account_info(),
                                },
                                signer_seeds,
                            ),
                            seller_bond,
                        )?;
                    }
                    DisputeResolution::SellerWins | DisputeResolution::Split => {
                        // Return bond to seller
                        token::transfer(
                            CpiContext::new_with_signer(
                                ctx.accounts.token_program.to_account_info(),
                                Transfer {
                                    from: bond_vault.to_account_info(),
                                    to: ctx.accounts.seller_token_account.to_account_info(),
                                    authority: ctx.accounts.escrow.to_account_info(),
                                },
                                signer_seeds,
                            ),
                            seller_bond,
                        )?;
                    }
                }
            }
        }

        let escrow = &mut ctx.accounts.escrow;
        escrow.status = EscrowStatus::Resolved;

        emit!(DisputeResolved {
            order_id: escrow.order_id.clone(),
            resolution,
            buyer_amount,
            seller_amount,
        });

        Ok(())
    }

    /// Cancel escrow before fulfillment.
    /// Callable by buyer (before shipped) or platform authority.
    pub fn cancel_escrow(ctx: Context<CancelEscrow>) -> Result<()> {
        let escrow = &ctx.accounts.escrow;

        let caller = ctx.accounts.caller.key();
        let is_buyer = caller == escrow.buyer;
        let is_platform = caller == escrow.platform_authority;

        require!(is_buyer || is_platform, EscrowError::Unauthorized);

        // Can only cancel before shipping
        let cancellable = escrow.status == EscrowStatus::Created
            || escrow.status == EscrowStatus::BondDeposited;
        require!(cancellable, EscrowError::InvalidStatus);

        let order_id = escrow.order_id.clone();
        let escrow_bump = escrow.bump;
        let refund_amount = escrow.amount;
        let seller_bond = escrow.seller_bond;

        let seeds = &[
            b"escrow".as_ref(),
            order_id.as_bytes(),
            &[escrow_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        // Refund buyer
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.buyer_token_account.to_account_info(),
                    authority: ctx.accounts.escrow.to_account_info(),
                },
                signer_seeds,
            ),
            refund_amount,
        )?;

        // Return seller bond if deposited
        if seller_bond > 0 && escrow.status == EscrowStatus::BondDeposited {
            if let Some(bond_vault) = &ctx.accounts.bond_vault {
                if let Some(seller_ta) = &ctx.accounts.seller_token_account {
                    token::transfer(
                        CpiContext::new_with_signer(
                            ctx.accounts.token_program.to_account_info(),
                            Transfer {
                                from: bond_vault.to_account_info(),
                                to: seller_ta.to_account_info(),
                                authority: ctx.accounts.escrow.to_account_info(),
                            },
                            signer_seeds,
                        ),
                        seller_bond,
                    )?;
                }
            }
        }

        let escrow = &mut ctx.accounts.escrow;
        escrow.status = EscrowStatus::Cancelled;

        emit!(EscrowCancelled {
            order_id: escrow.order_id.clone(),
            refund_amount,
        });

        Ok(())
    }
}

// ── Account Contexts ───────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(order_id: String)]
pub struct CreateEscrow<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    /// CHECK: Seller is just a pubkey reference, not signing.
    pub seller: UncheckedAccount<'info>,

    /// CHECK: Platform authority pubkey, not signing at creation.
    pub platform_authority: UncheckedAccount<'info>,

    #[account(
        init,
        payer = buyer,
        space = ESCROW_ACCOUNT_SIZE,
        seeds = [b"escrow", order_id.as_bytes()],
        bump
    )]
    pub escrow: Account<'info, EscrowAccount>,

    #[account(
        init,
        payer = buyer,
        token::mint = token_mint,
        token::authority = escrow,
        seeds = [b"vault", order_id.as_bytes()],
        bump
    )]
    pub vault: Account<'info, TokenAccount>,

    pub token_mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = buyer_token_account.owner == buyer.key(),
        constraint = buyer_token_account.mint == token_mint.key()
    )]
    pub buyer_token_account: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct DepositSellerBond<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,

    #[account(
        mut,
        seeds = [b"escrow", escrow.order_id.as_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, EscrowAccount>,

    #[account(
        init,
        payer = seller,
        token::mint = token_mint,
        token::authority = escrow,
        seeds = [b"bond", escrow.order_id.as_bytes()],
        bump
    )]
    pub bond_vault: Account<'info, TokenAccount>,

    pub token_mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = seller_token_account.owner == seller.key(),
        constraint = seller_token_account.mint == token_mint.key()
    )]
    pub seller_token_account: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct MarkShipped<'info> {
    pub seller: Signer<'info>,

    #[account(
        mut,
        seeds = [b"escrow", escrow.order_id.as_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, EscrowAccount>,
}

#[derive(Accounts)]
pub struct MarkDelivered<'info> {
    pub platform_authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"escrow", escrow.order_id.as_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, EscrowAccount>,
}

#[derive(Accounts)]
pub struct ReleaseEscrow<'info> {
    pub caller: Signer<'info>,

    #[account(
        mut,
        seeds = [b"escrow", escrow.order_id.as_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, EscrowAccount>,

    #[account(
        mut,
        seeds = [b"vault", escrow.order_id.as_bytes()],
        bump = escrow.vault_bump
    )]
    pub vault: Account<'info, TokenAccount>,

    /// Seller's USDC token account.
    #[account(
        mut,
        constraint = seller_token_account.owner == escrow.seller,
        constraint = seller_token_account.mint == escrow.token_mint
    )]
    pub seller_token_account: Account<'info, TokenAccount>,

    /// Platform fee token account.
    #[account(mut)]
    pub platform_token_account: Account<'info, TokenAccount>,

    /// Optional: bond vault for tier 3+ (seller bond return).
    #[account(mut)]
    pub bond_vault: Option<Account<'info, TokenAccount>>,

    /// Optional: seller token account for bond return.
    #[account(mut)]
    pub seller_token_account_for_bond: Option<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct OpenDispute<'info> {
    pub buyer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"escrow", escrow.order_id.as_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, EscrowAccount>,
}

#[derive(Accounts)]
pub struct ResolveDispute<'info> {
    pub platform_authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"escrow", escrow.order_id.as_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, EscrowAccount>,

    #[account(
        mut,
        seeds = [b"vault", escrow.order_id.as_bytes()],
        bump = escrow.vault_bump
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = buyer_token_account.owner == escrow.buyer,
        constraint = buyer_token_account.mint == escrow.token_mint
    )]
    pub buyer_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = seller_token_account.owner == escrow.seller,
        constraint = seller_token_account.mint == escrow.token_mint
    )]
    pub seller_token_account: Account<'info, TokenAccount>,

    /// Optional: bond vault for tier 3+.
    #[account(mut)]
    pub bond_vault: Option<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CancelEscrow<'info> {
    pub caller: Signer<'info>,

    #[account(
        mut,
        seeds = [b"escrow", escrow.order_id.as_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, EscrowAccount>,

    #[account(
        mut,
        seeds = [b"vault", escrow.order_id.as_bytes()],
        bump = escrow.vault_bump
    )]
    pub vault: Account<'info, TokenAccount>,

    /// Buyer's token account for refund.
    #[account(
        mut,
        constraint = buyer_token_account.owner == escrow.buyer,
        constraint = buyer_token_account.mint == escrow.token_mint
    )]
    pub buyer_token_account: Account<'info, TokenAccount>,

    /// Optional: bond vault (for returning seller bond).
    #[account(mut)]
    pub bond_vault: Option<Account<'info, TokenAccount>>,

    /// Optional: seller token account (for returning seller bond).
    #[account(mut)]
    pub seller_token_account: Option<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

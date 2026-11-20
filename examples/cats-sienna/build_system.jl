# Build a PowerSystems.jl System for CATS (California Test System) with one
# week of 2019 hourly profiles and real geography, ready for PowerSimulations.
#
# Inputs (paths from env, defaults match the Docker image):
#   CATS_DIR     clone of github.com/WISPO-POP/CATS-CaliforniaTestSystem
#   DATA_DIR     folder with Load_Agg_Post_Assignment_v3_latest.csv and
#                HourlyProduction2019.csv (the CATS authors' 2019 profiles)
#   START_HOUR   first hour of the week, counted from 2019-01-01T00:00
#                (default 5352 = 2019-08-12T00:00, the week of the 2019 peak)
#   HOURS        number of hours (default 168)
#   OUTPUT_DIR   where system.json is written
#
# The profile mapping follows CATS's Script/test_eval_functions.jl:
#   - load: row b of the load CSV is the "P+Qi" MW load of MATPOWER bus b
#     (only buses that have a load in the case are used);
#   - solar and wind: pmax_g(t) = fleet_total(t) * Pmax_g / fleet_capacity,
#     with the fleet type from FuelType in GIS/CATS_gens.csv.
#
# Simplifications for a visualization demo (see README.md):
#   - quadratic generator costs are replaced by their marginal cost at half
#     of Pmax, so the dispatch is a linear program;
#   - batteries, pumped storage and synchronous condensers are set unavailable.

using PowerSystems
using CSV
using DataFrames
using Dates
using JSON3
const PSY = PowerSystems
const TS = PowerSystems.TimeSeries

const CATS_DIR = get(ENV, "CATS_DIR", "/data/CATS-CaliforniaTestSystem")
const DATA_DIR = get(ENV, "DATA_DIR", "/data/profiles")
const START_HOUR = parse(Int, get(ENV, "START_HOUR", "5352"))
const HOURS = parse(Int, get(ENV, "HOURS", "168"))
const OUTPUT_DIR = get(ENV, "OUTPUT_DIR", "/output")
mkpath(OUTPUT_DIR)

const T0 = DateTime(2019, 1, 1) + Hour(START_HOUR)
const STAMPS = collect(T0:Hour(1):(T0 + Hour(HOURS - 1)))
@info "CATS demo week" start = T0 hours = HOURS

# ── Network ──────────────────────────────────────────────────────────────
sys = System(joinpath(CATS_DIR, "MATPOWER", "CaliforniaTestSystem.m"))
set_units_base_system!(sys, "DEVICE_BASE")

# MATPOWER generator row j is named "gen-j" and is row j of CATS_gens.csv.
gens_csv = CSV.read(joinpath(CATS_DIR, "GIS", "CATS_gens.csv"), DataFrame)
gen_row(name) = parse(Int, split(name, "-")[end])

const PM = PSY.PrimeMovers
const FU = PSY.ThermalFuels
# CATS / EIA-860 FuelType → (prime mover, fuel). The pairs match the
# technology keys that GAT uses to group dispatch by fuel.
const FUEL_MAP = Dict(
    "Natural Gas Fired Combined Cycle" => (PM.CC, FU.NATURAL_GAS),
    "Natural Gas Fired Combustion Turbine" => (PM.CT, FU.NATURAL_GAS),
    "Natural Gas Internal Combustion Engine" => (PM.IC, FU.NATURAL_GAS),
    "Natural Gas Steam Turbine" => (PM.ST, FU.NATURAL_GAS),
    "Other Natural Gas" => (PM.OT, FU.NATURAL_GAS),
    "Nuclear" => (PM.ST, FU.NUCLEAR),
    "Conventional Steam Coal" => (PM.ST, FU.COAL),
    "Petroleum Liquids" => (PM.CT, FU.DISTILLATE_FUEL_OIL),
    "Petroleum Coke" => (PM.ST, FU.PETROLEUM_COKE),
    "Other Gases" => (PM.CT, FU.OTHER),
    "Landfill Gas" => (PM.CT, FU.MUNICIPAL_WASTE),
    "Municipal Solid Waste" => (PM.ST, FU.MUNICIPAL_WASTE),
    "Other Waste Biomass" => (PM.ST, FU.MUNICIPAL_WASTE),
    "Wood/Wood Waste Biomass" => (PM.ST, FU.WOOD_WASTE),
    "Geothermal" => (PM.ST, FU.GEOTHERMAL),
    "Conventional Hydroelectric" => (PM.HY, FU.OTHER),
    "IMPORT" => (PM.OT, FU.OTHER),
    "All Other" => (PM.OT, FU.OTHER),
)
const UNAVAILABLE = Set(["Batteries", "Hydroelectric Pumped Storage", "Synchronous Condenser"])
is_solar(ft) = occursin("solar", lowercase(ft))
is_wind(ft) = occursin("wind", lowercase(ft))

# Marginal cost at half of Pmax, as a linear cost in the same units.
function linear_cost(g)
    vc = PSY.get_variable(get_operation_cost(g))
    curve = PSY.get_value_curve(vc)
    units = PSY.get_power_units(vc)
    pmax = get_active_power_limits(g).max          # device base (per unit)
    p_half = units == PSY.UnitSystem.NATURAL_UNITS ? 0.5 * pmax * get_base_power(g) :
             units == PSY.UnitSystem.SYSTEM_BASE ? 0.5 * pmax * get_base_power(g) / get_base_power(sys) :
             0.5 * pmax
    c = if curve isa PSY.QuadraticCurve
        PSY.get_proportional_term(curve) + 2 * PSY.get_quadratic_term(curve) * p_half
    elseif curve isa PSY.LinearCurve
        PSY.get_proportional_term(curve)
    else
        0.0
    end
    return ThermalGenerationCost(
        variable = CostCurve(LinearCurve(max(c, 0.0)), units),
        fixed = 0.0, start_up = 0.0, shut_down = 0.0,
    )
end

solar_cap = 0.0
wind_cap = 0.0
renewables = Tuple{RenewableDispatch, Symbol}[]
n_unavailable = 0
for g in collect(get_components(ThermalStandard, sys))
    ft = String(gens_csv[gen_row(get_name(g)), :FuelType])
    if is_solar(ft) || is_wind(ft)
        pmax = get_active_power_limits(g).max
        kind = is_solar(ft) ? :solar : :wind
        kind == :solar ? (global solar_cap += pmax) : (global wind_cap += pmax)
        r = RenewableDispatch(;
            name = get_name(g),
            available = true,
            bus = get_bus(g),
            active_power = get_active_power(g),
            reactive_power = get_reactive_power(g),
            rating = pmax,   # get_max_active_power(r) == rating
            prime_mover_type = kind == :solar ? PM.PVe : PM.WT,
            reactive_power_limits = get_reactive_power_limits(g),
            power_factor = 1.0,
            operation_cost = RenewableGenerationCost(CostCurve(LinearCurve(0.0))),
            base_power = get_base_power(g),
            ext = Dict{String, Any}("FuelType" => ft),
        )
        remove_component!(sys, g)
        add_component!(sys, r)
        push!(renewables, (r, kind))
    elseif ft in UNAVAILABLE
        set_available!(g, false)
        global n_unavailable += 1
    else
        pm, fuel = get(FUEL_MAP, ft, (PM.OT, FU.OTHER))
        set_prime_mover_type!(g, pm)
        set_fuel!(g, fuel)
        set_operation_cost!(g, linear_cost(g))
        set_ramp_limits!(g, nothing)
        set_ext!(g, Dict{String, Any}("FuelType" => ft))
    end
end
@info "Generators" thermal = length(get_components(ThermalStandard, sys)) renewables = length(renewables) unavailable = n_unavailable

# ── Profiles ─────────────────────────────────────────────────────────────
hourly = CSV.read(joinpath(DATA_DIR, "HourlyProduction2019.csv"), DataFrame)
rng = (START_HOUR + 1):(START_HOUR + HOURS)
solar_mw = Float64.(hourly[rng, :Solar])
wind_mw = Float64.(hourly[rng, :Wind])
base = get_base_power(sys)

for (r, kind) in renewables
    cap_mw = (kind == :solar ? solar_cap : wind_cap) * base
    series = clamp.((kind == :solar ? solar_mw : wind_mw) ./ cap_mw, 0.0, 1.0)
    add_time_series!(sys, r, PSY.SingleTimeSeries("max_active_power",
        TS.TimeArray(STAMPS, series); scaling_factor_multiplier = PSY.get_max_active_power))
end

# The load CSV is 8,870 rows (buses) × 8,760 columns (hours) of "P+Qi" MW.
# Stream it and keep only the week's columns for buses that have a load.
loads_by_bus = Dict(get_number(get_bus(l)) => l for l in get_components(PowerLoad, sys))
parse_p(s) = (i = findlast('+', s); parse(Float64, i === nothing || i == 1 ? s : s[1:prevind(s, i)]))
open(joinpath(DATA_DIR, "Load_Agg_Post_Assignment_v3_latest.csv")) do io
    for (b, line) in enumerate(eachline(io))
        haskey(loads_by_bus, b) || continue
        cells = split(line, ',')
        p = [parse_p(strip(cells[h])) / base for h in rng]
        peak = maximum(abs, p)
        l = loads_by_bus[b]
        if peak <= 0
            p = fill(1.0, HOURS); peak = 0.0
        end
        set_max_active_power!(l, peak)
        set_active_power!(l, peak)
        add_time_series!(sys, l, PSY.SingleTimeSeries("max_active_power",
            TS.TimeArray(STAMPS, peak > 0 ? p ./ peak : zeros(HOURS));
            scaling_factor_multiplier = PSY.get_max_active_power))
    end
end
@info "Loads with profiles" n = length(loads_by_bus)

# ── Geography ────────────────────────────────────────────────────────────
# Bus coordinates as GeographicInfo attributes (read by GAT), and the real
# line routes as a WKT `Line_Geometry` ext field (drawn by the GAT extension).
buses_csv = CSV.read(joinpath(CATS_DIR, "GIS", "CATS_buses.csv"), DataFrame)
coords = Dict(Int(r.bus_i) => (Float64(r.Lat), Float64(r.Lon)) for r in eachrow(buses_csv))
for bus in get_components(ACBus, sys)
    c = get(coords, get_number(bus), nothing)
    c === nothing && continue
    lat, lon = c
    add_supplemental_attribute!(sys, bus, GeographicInfo(geo_json = Dict{String, Any}(
        "type" => "Point", "coordinates" => [lon, lat], "Latitude" => lat, "Longitude" => lon)))
end

lines_gj = JSON3.read(read(joinpath(CATS_DIR, "GIS", "CATS_lines.json"), String))
features = lines_gj[:features]
# LineString coordinates are [[lon, lat], ...]; a few CATS routes are
# MultiLineStrings ([[[lon, lat], ...], ...]): join their parts in order.
flat(coords) = (!isempty(coords) && coords[1][1] isa AbstractVector) ? reduce(vcat, collect.(coords)) : collect(coords)
wkt(coords) = "LINESTRING(" * join(["$(c[1]) $(c[2])" for c in flat(coords)], ", ") * ")"
n_paths = 0
for br in Iterators.flatten((get_components(Line, sys), get_components(Transformer2W, sys)))
    m = match(r"i_(\d+)$", get_name(br))
    m === nothing && continue
    k = parse(Int, m.captures[1])
    1 <= k <= length(features) || continue
    f = features[k]
    set_ext!(br, Dict{String, Any}("CATS_ID" => k, "kV" => f[:properties][:kV]))
    if br isa Line && length(flat(f[:geometry][:coordinates])) >= 2
        get_ext(br)["Line_Geometry"] = wkt(f[:geometry][:coordinates])
        global n_paths += 1
    end
end
@info "Line routes attached" n = n_paths

# 24-hour decision windows, one per day of the week.
transform_single_time_series!(sys, Hour(24), Hour(24))
set_units_base_system!(sys, "SYSTEM_BASE")
to_json(sys, joinpath(OUTPUT_DIR, "system.json"); force = true)
@info "Wrote system" path = joinpath(OUTPUT_DIR, "system.json")

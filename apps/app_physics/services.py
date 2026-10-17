"""
apps/app_physics/services.py
=============================
Physics services: projectile motion with air drag, charged particles in a
magnetic field, magnetic pole forces and the DC motor start-up transient.
"""

import math
import numpy as np
from scipy.integrate import solve_ivp

# ---------------------------------------------------------------------------
# DC motor reference point
# ---------------------------------------------------------------------------
# The torque and back-EMF constants a user enters describe a nominal machine.
# The magnet material, pole span and pole count then scale those constants away
# from that nominal point, so the nominal point itself has to be stated
# somewhere. These two names are it.

#: Airgap flux density the entered Kt/Ke are assumed to have been measured at.
B_GAP_REFERENCE_T = 1.0

#: Pole count the entered Kt/Ke are assumed to describe (a 2-pole machine).
POLES_REFERENCE_COUNT = 2


#: Speed of sound in air at 15 °C. Above ~0.8 Mach a constant drag coefficient
#: badly underestimates drag (wave drag from the shock), so the result is flagged.
SPEED_OF_SOUND_M_S = 340.3


class ProjectileMotionService:
    """
    Trajectory of a sphere launched under gravity with quadratic air drag.

    Equations of motion, integrated with an adaptive Runge-Kutta (DOP853) and a
    terminal ground-impact event:

        m · a = m · g − ½ · C_d · ρ · A · |v| · v

    The launch may start above the ground (``launch_height_m``), and gravity and
    air density are inputs so the same solver covers the Moon (ρ = 0) or Mars.
    """

    def __init__(
        self,
        velocity_m_s: float,
        angle_deg: float,
        mass_kg: float,
        diameter_m: float,
        drag_coefficient: float,
        gravity_m_s2: float = 9.80665,
        air_density_kg_m3: float = 1.225,
        launch_height_m: float = 0.0,
    ):
        self.v0 = velocity_m_s
        self.theta_rad = math.radians(angle_deg)
        self.m = mass_kg
        self.d = diameter_m
        self.Cd = drag_coefficient
        self.g = gravity_m_s2
        self.rho = air_density_kg_m3
        self.h0 = launch_height_m
        self.A = math.pi * (diameter_m / 2.0) ** 2
        # Drag acceleration per unit speed², so a_drag = −k · |v| · v.
        self.k = 0.5 * self.Cd * self.rho * self.A / self.m

    def compute(self):
        vx0 = self.v0 * math.cos(self.theta_rad)
        vy0 = self.v0 * math.sin(self.theta_rad)
        warnings: list[str] = []

        # 1. Vacuum case — closed form. y(t) = h0 + vy0·t − g·t²/2 reaches 0 at
        #    the positive root of that quadratic.
        t_flight_vac = max((vy0 + math.sqrt(vy0 ** 2 + 2.0 * self.g * self.h0)) / self.g, 1e-3)
        h_max_vac = self.h0 + max(vy0, 0.0) ** 2 / (2.0 * self.g)
        range_vac = vx0 * t_flight_vac

        t_pts_vac = np.linspace(0.0, t_flight_vac, 100)
        x_vac = vx0 * t_pts_vac
        y_vac = np.clip(self.h0 + vy0 * t_pts_vac - 0.5 * self.g * t_pts_vac ** 2, 0.0, None)

        # 2. Drag case — adaptive integration up to the ground-impact event.
        #    A drag flight can outlast the vacuum one (a drop from height falls
        #    at terminal velocity), so the horizon is a generous bound; the
        #    terminal event is what actually ends the integration.
        def rhs(_t, s):
            _x, _y, vx, vy = s
            v = math.hypot(vx, vy)
            return [vx, vy, -self.k * v * vx, -self.g - self.k * v * vy]

        def hit_ground(_t, s):
            return s[1]
        hit_ground.terminal = True
        hit_ground.direction = -1

        sol = solve_ivp(
            rhs, (0.0, max(50.0 * t_flight_vac, 60.0)), [0.0, self.h0, vx0, vy0],
            method='DOP853', events=hit_ground, dense_output=True,
            rtol=1e-9, atol=1e-9, max_step=t_flight_vac / 20.0,
        )
        if sol.t_events[0].size:
            t_flight_drag = float(sol.t_events[0][0])
        else:  # pragma: no cover — gravity always brings it down within the horizon
            t_flight_drag = float(sol.t[-1])
            warnings.append("A integração terminou antes do impacto; alcance e tempo são limites inferiores.")

        t_drag = np.linspace(0.0, t_flight_drag, 150)
        x_drag, y_drag, vx_drag, vy_drag = sol.sol(t_drag)
        y_drag = np.clip(y_drag, 0.0, None)
        y_drag[-1] = 0.0

        vx_f, vy_f = float(vx_drag[-1]), float(vy_drag[-1])
        v_final = math.hypot(vx_f, vy_f)
        impact_angle_deg = math.degrees(math.atan2(-vy_f, vx_f))

        # Energy taken by drag: initial kinetic + potential minus kinetic at impact.
        e_initial = 0.5 * self.m * self.v0 ** 2 + self.m * self.g * self.h0
        e_impact = 0.5 * self.m * v_final ** 2
        drag_loss_j = max(0.0, e_initial - e_impact)

        terminal_velocity = math.sqrt(self.g / self.k) if self.k > 0 else None
        if self.k > 0 and max(self.v0, v_final) > 0.8 * SPEED_OF_SOUND_M_S:
            warnings.append(
                "Velocidade acima de Mach 0,8: o Cd constante subestima o arrasto "
                "(arrasto de onda transônico/supersônico)."
            )

        return {
            "x_vacuum": x_vac.tolist(),
            "y_vacuum": y_vac.tolist(),
            "x_drag": x_drag.tolist(),
            "y_drag": y_drag.tolist(),
            "t_drag": t_drag.tolist(),
            "warnings": warnings,
            "stats": {
                "range_vacuum_m": float(range_vac),
                "height_vacuum_m": float(h_max_vac),
                "time_vacuum_s": float(t_flight_vac),
                "range_drag_m": float(x_drag[-1]),
                "height_drag_m": float(np.max(y_drag)),
                "time_drag_s": t_flight_drag,
                "final_velocity_drag_m_s": v_final,
                "impact_angle_deg": impact_angle_deg,
                "terminal_velocity_m_s": terminal_velocity,
                "drag_energy_loss_j": drag_loss_j,
                "launch_height_m": self.h0,
                "gravity_m_s2": self.g,
                "air_density_kg_m3": self.rho,
                "truncated": False,
            }
        }


class MagnetismService:
    """
    Computes physical interactions for magnetism and motors:
    1. Charged particle in uniform magnetic field (Lorentz trajectory).
    2. Force between two magnetic poles.
    3. Transient response of a Permanent Magnet DC Motor (PMDC).
    """

    @staticmethod
    def compute_lorentz(q_uc: float, m_mg: float, v0: list, B: list):
        # q_uc in micro-Coulombs, m_mg in milligrams
        # Scaling factor: q/m in C/kg is exactly q_uc/m_mg.
        # q = q_uc * 1e-6 C, m = m_mg * 1e-6 kg, so q/m = q_uc / m_mg
        q_over_m = q_uc / m_mg if m_mg != 0 else 0.0

        # State: [x, y, z, vx, vy, vz]
        state = np.array([0.0, 0.0, 0.0, float(v0[0]), float(v0[1]), float(v0[2])])
        Bx, By, Bz = float(B[0]), float(B[1]), float(B[2])
        B_mag = math.sqrt(Bx**2 + By**2 + Bz**2)

        # Step and horizon follow the cyclotron period T = 2π/(|q/m|·B). A fixed
        # 5 ms step could not resolve a fast orbit (q/m = 1000 C/kg at 1 T has
        # T ≈ 6 ms) and RK4 then drew garbage; now every orbit gets 200 steps,
        # and fast particles are shown for three turns instead of hundreds.
        omega_c = abs(q_over_m) * B_mag
        if omega_c > 0:
            period = 2.0 * math.pi / omega_c
            t_max = min(2.0, 3.0 * period)
            dt = min(0.005, period / 200.0)
        else:
            t_max, dt = 2.0, 0.005

        def derivatives(s):
            vx, vy, vz = s[3], s[4], s[5]
            # acceleration = q/m * (v x B)
            # v x B = [vy*Bz - vz*By, vz*Bx - vx*Bz, vx*By - vy*Bx]
            ax = q_over_m * (vy * Bz - vz * By)
            ay = q_over_m * (vz * Bx - vx * Bz)
            az = q_over_m * (vx * By - vy * Bx)
            return np.array([vx, vy, vz, ax, ay, az])

        trajectory = [state.copy()]
        t = 0.0
        steps = int(t_max / dt)

        for _ in range(steps):
            k1 = derivatives(state)
            k2 = derivatives(state + k1 * (dt / 2.0))
            k3 = derivatives(state + k2 * (dt / 2.0))
            k4 = derivatives(state + k3 * dt)

            state += (k1 + 2.0 * k2 + 2.0 * k3 + k4) * (dt / 6.0)
            trajectory.append(state.copy())
            t += dt

        traj_arr = np.array(trajectory)

        # Downsample for frontend (~300 samples: smooth enough for three turns)
        step_sz = max(1, len(traj_arr) // 300)
        resampled = traj_arr[::step_sz]

        x = resampled[:, 0].tolist()
        y = resampled[:, 1].tolist()
        z = resampled[:, 2].tolist()
        vx = resampled[:, 3].tolist()
        vy = resampled[:, 4].tolist()
        vz = resampled[:, 5].tolist()

        # Calculate force at each step: F = q * (v x B)
        q_c = q_uc * 1e-6
        Fx = [q_c * (vy_i * Bz - vz_i * By) for vy_i, vz_i in zip(vy, vz)]
        Fy = [q_c * (vz_i * Bx - vx_i * Bz) for vx_i, vz_i in zip(vx, vz)]
        Fz = [q_c * (vx_i * By - vy_i * Bx) for vx_i, vy_i in zip(vx, vy)]

        # Larmor radius: R = m * v_perp / (|q| * B)
        # v_perp = |v x B| / |B|
        # cyclotron frequency: f = |q| * B / (2 * pi * m)
        v_mag = math.sqrt(v0[0]**2 + v0[1]**2 + v0[2]**2)
        if B_mag > 0:
            # Cross product v x B
            cross_x = v0[1]*Bz - v0[2]*By
            cross_y = v0[2]*Bx - v0[0]*Bz
            cross_z = v0[0]*By - v0[1]*Bx
            cross_mag = math.sqrt(cross_x**2 + cross_y**2 + cross_z**2)
            v_perp = cross_mag / B_mag

            if q_uc != 0:
                larmor_r = (m_mg * v_perp) / (abs(q_uc) * B_mag)
                cyclotron_f = (abs(q_uc) * B_mag) / (2.0 * math.pi * m_mg)
            else:
                larmor_r = float('inf')
                cyclotron_f = 0.0
        else:
            v_perp = 0.0
            larmor_r = float('inf')
            cyclotron_f = 0.0

        return {
            "x": x, "y": y, "z": z,
            "vx": vx, "vy": vy, "vz": vz,
            "Fx": Fx, "Fy": Fy, "Fz": Fz,
            "stats": {
                "larmor_radius_m": None if larmor_r == float('inf') else larmor_r,
                "cyclotron_frequency_hz": cyclotron_f,
                "velocity_perp_m_s": v_perp,
                "velocity_total_m_s": v_mag,
                "magnetic_field_mag_t": B_mag,
            }
        }

    @staticmethod
    def compute_poles(qm1: float, qm2: float, r: float):
        # Coulomb's law for magnetism: F = mu_0 * qm1 * qm2 / (4 * pi * r^2)
        # F = 1e-7 * qm1 * qm2 / r^2
        # Sweep a window centred on the operating separation instead of a fixed
        # 0.05-2 m span. `r` has no upper bound and only a cross-field check for
        # positivity, so outside that span the operating-point marker the chart
        # draws fell off the plotted curve entirely.
        r_lo = max(r * 0.2, 1e-4)
        r_hi = max(r * 2.0, r_lo * 1.01)
        r_profile = np.linspace(r_lo, r_hi, 100)
        f_profile = (1e-7 * qm1 * qm2) / (r_profile ** 2)

        force_val = (1e-7 * qm1 * qm2) / (r ** 2) if r > 0 else 0.0

        # Sign convention: like poles give a positive (repulsive) product,
        # opposite poles a negative (attractive) one. Zero is neither — it used
        # to fall through to "Repulsion".
        if force_val > 0:
            interaction = "Repulsion"
        elif force_val < 0:
            interaction = "Attraction"
        else:
            interaction = "None"

        return {
            "r_profile": r_profile.tolist(),
            "f_profile": f_profile.tolist(),
            "stats": {
                "distance_m": r,
                "force_n": force_val,
                "type": interaction,
            }
        }

    @staticmethod
    def compute_motor(
        V: float, R: float, L: float, J: float, b: float, Kt: float, Ke: float, tl: float,
        poles_count: int = 2, magnet_material: str = "ndfeb_n52", pole_span_deg: float = 120.0,
    ):
        """
        Start-up transient of a permanent-magnet DC motor.

            L · dI/dt = V − R·I − Ke·ω
            J · dω/dt = Kt·I − b·ω − τ_load(ω)

        The load is passive: it opposes rotation and can hold the rotor still,
        but never drives it backwards (a constant torque used to spin a
        "stalled" motor in reverse). Integrated with LSODA, which switches to a
        stiff method on its own — a small L/R next to a large J/b made the old
        fixed-step RK4 blow up. The horizon follows the machine's own time
        constants instead of a fixed 1.5 s, and the steady state is the exact
        algebraic one rather than an average of the last samples.
        """
        MATERIALS = {
            "ndfeb_n52": {"name": "Neodímio N52 (NdFeB)", "br": 1.45, "temp_max": "80°C"},
            "ndfeb_n42": {"name": "Neodímio N42 (NdFeB)", "br": 1.30, "temp_max": "80°C"},
            "smco": {"name": "Samário-Cobalto (Sm2Co17)", "br": 1.10, "temp_max": "300°C"},
            "alnico5": {"name": "AlNiCo 5", "br": 1.25, "temp_max": "525°C"},
            "ferrite": {"name": "Ferrite Bário (Y30)", "br": 0.40, "temp_max": "250°C"},
        }
        mat_info = MATERIALS.get(magnet_material, MATERIALS["ndfeb_n52"])
        br = mat_info["br"]

        # Calculated Airgap Flux Density: B_gap = B_r * (span_deg / 180.0) * leakage_factor (0.85)
        span_clamped = max(30.0, min(170.0, float(pole_span_deg)))
        b_gap = br * (span_clamped / 180.0) * 0.85

        # Effective torque & back-EMF constants.
        #
        # Kt and Ke are entered for a nominal machine; the magnet choice, pole
        # span and pole count scale them away from that nominal point. Both
        # reference values are named rather than left as bare literals.
        #
        # Torque per amp is proportional to the number of active pole pairs, so
        # `poles_count` scales the constants relative to the 2-pole reference.
        pole_pairs = max(1, int(poles_count) // 2)
        pole_factor = pole_pairs / (POLES_REFERENCE_COUNT // 2)

        flux_factor = (b_gap / B_GAP_REFERENCE_T) * pole_factor
        Kt_eff = Kt * flux_factor
        Ke_eff = Ke * flux_factor

        warnings: list[str] = []
        direction = 1.0 if V >= 0 else -1.0
        tau_e = L / R
        tau_m = J * R / (R * b + Kt_eff * Ke_eff)

        stall_current = V / R
        stall_torque = Kt_eff * abs(V) / R
        no_load_speed = V / Ke_eff
        stalled = stall_torque <= tl

        # Exact steady state of the equations above.
        if stalled:
            omega_ss, I_ss = 0.0, stall_current
            warnings.append(
                f"Torque de partida ({stall_torque:.2f} N·m) não vence a carga "
                f"({tl:.2f} N·m): o motor fica travado e toda a potência vira calor no enrolamento."
            )
        else:
            omega_ss = direction * (Kt_eff * abs(V) - R * tl) / (R * b + Kt_eff * Ke_eff)
            I_ss = (b * omega_ss + direction * tl) / Kt_eff

        if abs(Kt - Ke) > 0.01 * max(Kt, Ke):
            warnings.append(
                "Kt ≠ Ke: em unidades SI uma máquina ideal tem Kt [N·m/A] = Ke [V·s/rad]; "
                "com valores diferentes o balanço de energia não fecha."
            )

        t_end = float(np.clip(6.0 * (tau_e if stalled else max(tau_m, tau_e)), 0.2, 120.0))
        t_eval = np.linspace(0.0, t_end, 600)

        if stalled:
            # The rotor never moves (Kt·I ≤ Kt·V/R ≤ τ_load throughout), so the
            # current is a plain first-order rise: closed form, no ODE needed.
            I = stall_current * (1.0 - np.exp(-t_eval / tau_e))
            omega = np.zeros_like(t_eval)
            load = np.zeros_like(t_eval)
        else:
            # Passive load, regularised so the right-hand side stays smooth:
            # tanh(ω/ω_s) ≈ sign(ω) once the rotor moves faster than ω_s, a
            # small fraction of the no-load speed.
            omega_s = max(1e-3, 2e-3 * abs(no_load_speed))

            def rhs(_t, s):
                i, w = s
                return [
                    (V - R * i - Ke_eff * w) / L,
                    (Kt_eff * i - b * w - tl * math.tanh(w / omega_s)) / J,
                ]

            sol = solve_ivp(
                rhs, (0.0, t_end), [0.0, 0.0], method='LSODA', t_eval=t_eval,
                rtol=1e-7, atol=[1e-7 * max(1.0, abs(stall_current)), 1e-7 * max(1.0, abs(no_load_speed))],
            )
            if not sol.success:  # pragma: no cover — LSODA handles this system's stiffness
                raise RuntimeError(f"Motor ODE integration failed: {sol.message}")
            I, omega = sol.y
            load = tl * np.tanh(omega / omega_s)

        torque = Kt_eff * I
        p_in = V * I
        p_out = load * omega
        efficiency = np.where((p_in > 1e-9) & (p_out > 0), 100.0 * p_out / np.where(p_in > 1e-9, p_in, 1.0), 0.0)
        efficiency = np.clip(efficiency, 0.0, 100.0)

        # Steady-state power split. With Kt = Ke these add up exactly:
        # P_elec = P_cu + P_fric + P_shaft.
        p_elec = V * I_ss
        p_cu = I_ss ** 2 * R
        p_fric = b * omega_ss ** 2
        p_shaft = tl * abs(omega_ss)
        efficiency_steady = 100.0 * p_shaft / p_elec if p_elec > 1e-9 else 0.0

        # Settling time: last entry into the ±5 % band around the steady state,
        # of the speed — or of the current when the rotor is held.
        tracked, target = (I, I_ss) if stalled else (omega, omega_ss)
        band = 0.05 * abs(target) if abs(target) > 1e-9 else 1e-6
        outside = np.nonzero(np.abs(tracked - target) > band)[0]
        if outside.size == 0:
            settling_time = 0.0
        elif outside[-1] + 1 < len(t_eval):
            settling_time = float(t_eval[outside[-1] + 1])
        else:
            settling_time = t_end

        def to_list(arr):  # 600 solver samples → 300 plotted
            return arr[::2].tolist()
        rpm = 30.0 / math.pi

        return {
            "t": to_list(t_eval),
            "I": to_list(I),
            "speed_rad_s": to_list(omega),
            "speed_rpm": to_list(omega * rpm),
            "torque_nm": to_list(torque),
            "efficiency_pct": to_list(efficiency),
            "warnings": warnings,
            "stats": {
                "steady_state_speed_rpm": omega_ss * rpm,
                "steady_state_speed_rad_s": omega_ss,
                "steady_state_current_a": I_ss,
                "starting_current_a": float(np.max(np.abs(I))),
                "settling_time_s": settling_time,
                "max_torque_nm": float(np.max(np.abs(torque))),
                "max_efficiency_pct": float(np.max(efficiency)),
                "stalled": stalled,
                "stall_torque_nm": stall_torque,
                "stall_current_a": abs(stall_current),
                "no_load_speed_rpm": no_load_speed * rpm,
                "kt_eff": Kt_eff,
                "ke_eff": Ke_eff,
                "tau_e_s": tau_e,
                "tau_m_s": tau_m,
                "t_end_s": t_end,
                "poles_count": poles_count,
                "magnet_material": magnet_material,
                "magnet_material_name": mat_info["name"],
                "remanence_br_t": br,
                "b_gap_t": round(b_gap, 3),
                "pole_span_deg": round(span_clamped, 1),
                "p_elec_w": round(p_elec, 2),
                "p_mech_w": round(p_shaft, 2),
                "p_cu_w": round(p_cu, 2),
                "p_fric_w": round(p_fric, 2),
                "efficiency_steady_pct": round(efficiency_steady, 1),
            }
        }
